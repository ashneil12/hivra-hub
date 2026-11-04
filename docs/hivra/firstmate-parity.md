# Firstmate parity

Source checkout (read-only): `/Users/ash/Worktrees/_sources/firstmate` (Kun Chen, MIT, Copyright (c) 2026 Kun Chen).
Hivra branch: `wp/fm-parity`. Packages in scope: WP-10 (contract and brief), WP-11 (watcher), WP-12 (delivery and merge), WP-14 (steering and decisions).

A row is **covered** when Hivra already did that rule. **Missing, now ported** when this branch adds it. **Not applicable** when the original is a firstmate home, a pane backend, another forge, or another Hivra package, and the why says which.

## Counts

Rules in the tables: 28 covered, 30 missing and now ported, 28 not applicable (86 rows).

`rg --files` on the checkout, excluding `.git`, lists 833 files. The index at the bottom names each one. Files judged in the tables are marked there. Every other file is not applicable, and the line says which family it belongs to.

## What this branch ports

1. The delivery engine was not on this branch. It is `src-tauri/src/delivery/` (from the WP-12 commits, behaviour ported, shell not copied) and the hooks in `lib.rs`, `fs.rs`, `land.rs`, `pr_watch/mod.rs`, `session_store.rs` and `worktrees.rs`. Tests: `src-tauri/src/delivery/tests.rs` (23 tests, `cargo test --lib delivery::`).
2. Contract and brief sentences that Hivra had paraphrased are now the original sentences, in `src/features/firstmate/vendor/firstmate-contract.md` (MIT header, `vendor/LICENSE`). `contract.md` and `renderBrief` contain each fenced block. A one-line Hivra binding follows a block where the original names a status file, an inbox directory, `bin/fm-*`, or "captain". Rewrite: Hivra has none of those; the checkout guard, `task_cannot`, the steering table and the delivery merge path do those jobs. Test: `keeps firstmate's vendored sentences verbatim in the prompt they belong to`.

## WP-10 contract and brief

| Rule or edge | Verdict | Where |
| --- | --- | --- |
| Hard rule 1, never write to a project | Missing, now ported (the original sentences). Enforcement was already there | `vendor/firstmate-contract.md`; `readOnly.ts`; `checkout_guard.rs`; `useFirstMateCheckoutGuard.ts` |
| The only direct edit is one concrete in-the-moment approval, never broadened | Covered, as the binding under rule 1 | `contract.md` |
| Fleet sync, secondmate sync, self-update and script-owned local-only merge exceptions | Not applicable | No such scripts. The binding says so |
| Hard rule 2, never merge without an explicit word; yolo is the only standing relaxation | Missing, now ported (the original sentences). The merge path enforces it | `delivery/merge.rs` `an_agent_merge_asks_the_person_and_merges_only_the_head_they_allowed`, `the_switch_merges_green_without_asking_and_never_red` |
| Hard rule 3, never tear down unlanded work; no `--force` bypass | Covered | `delivery/teardown.rs` `teardown_keeps_a_copy_whose_work_has_not_landed_or_merged` |
| A scout worktree may be discarded once its report exists | Not applicable | Hivra has no scout worktree type |
| Hard rule 4, workers never address the person | Covered | `decisions.rs` `check_may_ask`; brief status line "never address the person yourself" (`brief.test.ts`) |
| Direct intervention in a worker window is reconciled at the next review | Not applicable | Hivra has no crew panes to intervene in |
| Hard rule 5, report failure plainly; a worker's opinion is not evidence | Covered | `firstmate/report.rs`; `derive_status` in `status.rs` |
| Captain address, once per chat message, never in a commit or PR | Not applicable | Hivra says "the person". The binding forbids the word captain |
| Depth cap 2 | Covered | `firstmate/mod.rs` `MAX_DEPTH`, `check_depth` |
| Small ask goes to one worker; a larger ask is 3 to 8 independent tasks plus one synthesis, each with a check | Covered | `contract.md` Intake. The numbers are Hivra's (WP-10), from ROMA's idea, and no ROMA text is copied |
| Brief scaffold: isolation, intent, spec, definition of done, status, steering. The model fills only three | Covered | `brief.ts` `renderBrief`; `brief.test.ts` "writes the fixed sections" |
| Empty or placeholder sections are refused, including `{TASK}`, `{FIRSTMATE_SPEC}`, `{{intent}}`, `<your intent here>`, `[fill in]`, and not `${PORT}` or `{{ user.name }}` | Covered | `sectionProblem`; `brief.test.ts` |
| Intent is the person's ask, not widened; spec names what stays out | Missing, now ported (AGENTS.md section 11, verbatim) | `contract.md` Briefs |
| Isolation: `pwd -P` and `git rev-parse --show-toplevel`; `git-dir` does not prove it; STOP and do not branch or commit | Missing, now ported | `renderBrief` own-checkout; `brief.test.ts` |
| Isolation failure appends `blocked` to a status file | Not applicable as a file. The binding reports that line with `task_cannot` | `brief.ts` |
| A shared folder and a first-mate brief (read, don't edit) | Covered. firstmate has no such scaffold; Hivra does, because a Lead can brief itself | `brief.ts` `shared`, `first-mate` |
| Status lines are sparse; `working:` does not end the turn; the same obstacle twice is `blocked`; a decision is `needs-decision` and stops | Missing, now ported (fm-brief.sh lines 803-822) | `renderBrief` for a worker |
| `done:` and `working:` never close an open decision key; only `resolved` with that key does | Missing, now ported as the sentence. The parser is not applicable (no status file). Hivra keys come from `ask_person`, and answering releases every waiter | `brief.ts`; `decisions.rs` |
| A PR is named by its full https URL, never a bare number | Missing, now ported (inside the status block) | `brief.ts` |
| Steering inbox: list `*.msg`, read a record through a final line that has no newline, ack by `mv` to `handled/` | Missing, now ported as the sentence. The files are not applicable | `brief.ts`. Binding: a steering row arrives in the chat (`steering.rs`) |
| `body-terminator=1` means one synthetic trailing newline is not part of the body | Missing, now ported as the sentence. No file reader | `brief.ts` |
| Project `AGENTS.md` / `CLAUDE.md` is edited only to correct a fact, never to add knowledge, and `fm-ensure-agents-md.sh` is not run | Missing, now ported | `brief.ts` `# Project memory` |
| Refusing to overwrite an existing brief file, and no `--yolo` on the brief | Not applicable | Hivra does not write a brief file. `yolo` is the project switch (`settings.rs`), off by default |
| Mode-specific definition-of-done blocks, the no-mistakes `--yes` ban, and latching `local_done_head` | Not applicable | `fm-dod-lib.sh` renders a no-mistakes pipeline Hivra does not run. The goal is the model's check, refused when empty |
| Herdr lab scaffold (`--herdr-lab`) | Not applicable | No Herdr backend |
| Read-only launch per CLI, and an after-turn checkout flag with revert of a clean path only | Covered | `model/readOnly.ts`; `firstmate/README.md`; `checkout_guard.rs` |
| Five statuses from one function | Covered | `status.rs` `derive_status`. A stall is a notice, not a state. A question is "needs you" only when it is for the person. A usage-limit wait is paused |
| Typed worker report | Covered | `firstmate/report.rs` |

## WP-11 watcher

| Rule or edge | Verdict | Where |
| --- | --- | --- |
| One headless classifier; no model, CLI or tokens | Covered | `watcher/classifier.ts`; `watcher.headless.test.ts` |
| Wake only for judgment: done, failed, blocked, asking, stall, silence, PR, timer | Covered | `classifyRow`; `classifier.test.ts` |
| Stall notice once per silent stretch, re-armed only after activity | Covered | `watcher/stall.ts`; `stall.test.ts` |
| 20 minutes with no events, and no pending approval or question, stops the worker and wakes once | Covered | `SILENCE_MS`; `classifier.test.ts` |
| Approvals and questions are not silence | Covered | `classifier.test.ts` |
| Durable queue: pending, queued, delivered, acknowledged. Survives a restart | Covered | `watcher/queue.rs`; `wakeQueue.test.ts` |
| Drain, then ack through the generation that was seen; a newer seq is not acked | Covered | `queue.rs` `drain`, `ack` |
| Draining again before delivery returns the same turn | Covered | `queue.rs` `drain` |
| A stall whose worker has since moved on is disposed, not delivered late | Covered | `queue.rs` `drain` |
| CI red, CI green, merged and closed feed the classifier | Missing, now ported (the delivery event path was not on this branch) | `pr_watch/mod.rs` calls `delivery::events::classify` and `record`; `pr_watch_reads_classify_as_ci_red_green_merged_and_closed` |
| A restart is a non-event: rebuild from records and drain | Covered | WP-11 build item 6; the queue is in the database, so a new process sees it |
| Drain prints OPEN DECISIONS even when the queue is empty | Not applicable | An open decision is already a Needs row (`decisions.rs`). Waking the model again would spend a turn. WP-11 wakes only for something new |
| UNREAD STATUS and RECORD DIVERGENCE sections | Not applicable | Those compare a status-file ledger Hivra does not keep |
| Wake grant, pty doorbell, herdr/agy/kiro confirm dialogs | Not applicable | `fm-wake-grant.sh`, `fm-send-agy-confirm.test.sh`, `fm-send-kiro-confirm.test.sh`. Delivery is the database ladder |
| Watcher file lock, and never `pkill` a sibling home's watcher | Not applicable | `fm-watcher-lock.test.sh`. One poller thread in this process (`pr_watch`) |
| Arm, checkpoint, triage, wedge cap | Not applicable | `fm-watch-arm.sh`, `fm-watch-checkpoint.sh`, `fm-watch-triage*.test.sh`. Those drive a shell watcher in a pane |
| Decision-key slug (`A-Za-z0-9._-` only), key-before-colon, keyless folds to `default`, reserved `pending-reply-`, `corr=` plus 16 hex digits | Not applicable | `fm-classify-lib.sh`, `fm-classify-decision-key.test.sh`, `fm-classify-corr-token.test.sh`. Workers do not emit those status lines. `decisions.rs` `key_like` allows `:` and `/` on purpose, because the key is an argument, not a line to parse |

## WP-12 delivery and merge

| Rule or edge | Verdict | Where |
| --- | --- | --- |
| Per-project mode: local, PR, checked PR. firstmate's registry words are `no-mistakes`, `direct-PR` and `local-only` (`fm-project-mode.sh`); `direct-PR` is PR and `local-only` is local. Checked PR is this package's "ready only when green". `no-mistakes` is the row below | Missing, now ported | `delivery/settings.rs`; `the_default_is_checked_pr_with_a_github_remote_and_gh_signed_in_otherwise_local` |
| Default: checked PR when GitHub remote and `gh` is signed in, otherwise local | Missing, now ported | same test |
| A stale settings write does not overwrite a newer choice | Missing, now ported | `a_stale_settings_write_does_not_overwrite_a_newer_choice` |
| `yolo` ("merge without asking") off by default, orthogonal to the mode | Missing, now ported | `settings.rs`; `the_switch_merges_green_without_asking_and_never_red` |
| Local lands with `land.rs` and pushes nothing | Missing, now ported | `local_lands_the_change_in_the_project_and_pushes_nothing` |
| PR pushes the branch and opens a pull request whose body carries the brief and the worker's evidence, not its opinion | Missing, now ported | `pr_pushes_the_branch_and_opens_a_pull_request_with_the_brief_and_evidence` |
| Checked PR is ready only when green; the first red sends one fix round with the log; a second red fails it | Missing, now ported | `checked_pr_is_ready_only_when_green_and_gets_one_fix_round_for_red`; `the_fix_round_carries_the_failing_log` |
| A checked PR already green or red on the first read settles, because that read is stored as already told | Missing, now ported | `a_checked_pr_already_green_or_red_on_the_first_read_settles_once`; `events::note_current` |
| Refuse to deliver the base or default branch, and refuse a PR with uncommitted work | Missing, now ported | `pr_and_checked_pr_refuse_a_worker_on_the_base_or_the_default_branch`; `a_pr_mode_refuses_uncommitted_work_and_records_nothing` |
| One merge path. Refuses red or pending checks, a draft, a conflict, and a closed pull request | Missing, now ported | `decide_refuses_red_pending_drafts_conflicts_and_open_decisions` |
| Refuses while a decision on that work is open, including the person's own merge | Missing, now ported | `an_open_question_on_the_work_blocks_even_the_persons_merge`; `an_open_wp14_decision_on_the_trees_task_blocks_the_merge` |
| An agent merges only its own delivery, and only the head the person allowed (`--match-head-commit`) | Missing, now ported | `an_agent_merge_uses_only_the_delivery_record`; `an_agent_merge_asks_the_person_and_merges_only_the_head_they_allowed` |
| No checks at all is not green: the switch does not merge it | Missing, now ported | `merge.rs` (a pull request with no checks still needs the person's word) |
| Every attempt is logged with who allowed it | Missing, now ported | `delivery_merges`; `merge.rs` `record` |
| The Inbox merge button uses the same path | Missing, now ported | `fs.rs` `git_github_pr_action`; `the_inbox_merge_button_goes_through_the_same_path` |
| A git or `gh` child does not inherit the process environment | Missing, now ported | `a_git_child_does_not_inherit_the_process_environment`; `delivery/mod.rs` `CHILD_ENV` |
| Teardown never removes a worktree whose work has not landed or merged. A later edit in the project makes it unlanded again | Missing, now ported | `teardown_keeps_a_copy_whose_work_has_not_landed_or_merged`; `land.rs` `landed_in` |
| The janitor still will not remove a landed but unmerged copy | Missing, now ported | `the_janitor_never_offers_to_remove_a_landed_but_unmerged_copy` |
| A failed forge lookup stays a failure and is never read as a merge | Covered | `pr_watch` `ReadError::Failed`; `eight_failed_reads_in_a_row_end_the_watch_and_say_so`. `classify` only sees a successful read |
| A failed record of that read is not final: the watch stays open and the next sweep tries the same read again | Missing, now ported | `a_failed_delivery_record_does_not_end_the_watch`. firstmate publishes the outcome before it commits the marker (`fm-merge-outcome-lib.sh`); Hivra keeps the record in the same transaction as ending the watch |
| An opt-in PR health monitor that wakes once per new condition, and keeps watching after the worker is gone | Not applicable | `fm-pr-health.sh`. CI red, green, merged and closed already feed the classifier. This extra monitor is a firstmate home |
| Suggesting reviewers from recent authorship | Not applicable | `fm-pr-reviewers.sh`. Read-only advice, not a merge rule |
| A pre-push guard for an external review forge | Not applicable | `fm-git-push-guard.sh`. Hivra has no such forge. Local mode pushes nothing (`local_lands_the_change_in_the_project_and_pushes_nothing`) |
| Creating an `AGENTS.md` skeleton and a `CLAUDE.md` pointer | Not applicable | `fm-ensure-agents-md.sh`. The brief already says not to run it (the project-memory sentences). Hivra does not write that skeleton |
| `no-mistakes` as a mode, its pipeline, and an independent reviewer | Not applicable | WP-12's modes are local, PR and checked PR. The verbatim bullets stay in the contract so the rule is visible, and the binding names Hivra's three |
| Attended-only `--allow-red` / `--allow-missing`, and a GitLab merge with no head pipeline | Not applicable | Hivra never merges red or pending. Stricter than firstmate, on purpose |
| Away posture, merge-authority file, Gerrit, GitLab `glab`, Forgejo `tea` | Not applicable | `fm-merge-authority-lib.sh`, `fm-pr-merge.sh`. The one path is GitHub `gh` |
| A missing `gh` stops before any state is recorded | Not applicable as "record nothing" | A missing `gh` still refuses. Hivra then logs the failed attempt (`merge.rs`), which firstmate does not. The refusal is the rule |
| `fm-landed-lib.sh` "Recently Landed" backlog selector | Not applicable | Bearings and the fleet ledger, not a delivery mode |
| `fm-gate-refuse-lib.sh` stopping a no-mistakes gate agent from driving the fleet | Not applicable | Hivra does not run no-mistakes gate agents |
| `fm-decision-hold.sh` shim onto the backlog hold | Not applicable | A compatibility shim for `fm-captain-hold.sh`. Hivra's hold is `decisions.rs` |

## WP-14 steering and decisions

| Rule or edge | Verdict | Where |
| --- | --- | --- |
| A message is stored first, then steered or held; pending, delivered or failed; survives a restart | Covered | `steering.rs`; `steering.test.ts`; `useSteering.test.ts` |
| A worker's question goes to its first mate, never the person | Covered | `decisions.rs` `check_may_ask` |
| One decision per stable `(project, decision_key)`; asking again changes nothing | Covered | `decisions.rs` `ask` |
| Answering releases every waiter | Covered | `decisions.rs` |
| Caps refuse with a reason: fan-out 8, question length, option count, waiting messages | Covered | `MAX_FANOUT` in `firstmate/mod.rs`; `decisions.rs`; `steering.rs` |
| Re-ring an unacknowledged inbox file until it is moved, then treat the worker as stuck | Not applicable as files | The steering row stays pending until the CLI takes it, and the silence watchdog stops a worker that goes quiet. The ack sentence is vendored so the worker knows a message was received |
| `fm-send` resend token `FM_PENDING_REPLY_EXISTING_CORR` for a remote secondmate | Not applicable | No remote secondmate transport |
| `--resolve-key` closing a status-file decision at answer time | Not applicable as a flag | Answering the decision row releases the waiters, which is the same outcome |

## File index

Listed from the checkout on 4 Nov 2026 (`rg --files`, excluding `.git`): 833 files. "Rule table" means the rules in that file are judged in the tables above, including where the verdict there is not applicable. Nothing below is a package this branch was asked to build.

### Root

| File | Verdict |
| --- | --- |
| `AGENTS.md` | Rule table. Hard rules, delivery path, escalation, brief fill |
| `CLAUDE.md` | Not applicable. Pointer at `AGENTS.md` for Claude Code |
| `CONTRIBUTING.md` | Not applicable. firstmate's own contribution notes |
| `GROK_BOT.md` | Not applicable. Grok bot notes |
| `LICENSE` | Not applicable as a rule. MIT text, vendored at `src/features/firstmate/vendor/LICENSE` |
| `README.md` | Not applicable. Project readme; the contract sentences that matter are in `AGENTS.md` |
| `VISION.md` | Not applicable. Product vision, not a package rule |
| `.gitattributes` | Not applicable. Line endings |
| `.gitignore` | Not applicable |
| `.no-mistakes.yaml` | Not applicable. no-mistakes pipeline config |
| `.tasks.toml` | Not applicable. firstmate's own task runner |
| `assets/banner.png` | Not applicable. Banner image |

### bin, judged in the tables

`fm-brief.sh`, `fm-brief-heading-lib.sh`, `fm-dod-lib.sh`, `fm-classify-lib.sh`, `fm-watch.sh`, `fm-watch-arm.sh`, `fm-watch-checkpoint.sh`, `fm-wake-lib.sh`, `fm-wake-drain.sh`, `fm-wake-grant.sh`, `fm-pr-merge.sh`, `fm-pr-check.sh`, `fm-pr-lib.sh`, `fm-pr-poll.sh`, `fm-pr-state.sh`, `fm-pr-health.sh`, `fm-pr-reviewers.sh`, `fm-merge-outcome-lib.sh`, `fm-teardown.sh`, `fm-send.sh`, `fm-task-inbox-lib.sh`, `fm-inbox.sh`, `fm-decision-hold.sh`, `fm-gate-refuse-lib.sh`, `fm-merge-authority-lib.sh`, `fm-merge-local.sh`, `fm-landed-lib.sh`, `fm-project-mode.sh`, `fm-git-push-guard.sh`, `fm-ensure-agents-md.sh`, `fm-pending-reply-lib.sh`.

`fm-pr-lib.sh`, `fm-pr-poll.sh` and `fm-pr-check.sh` are the poll sidecar (GitHub, GitLab, Gerrit, Forgejo). The GitHub outcomes are the classifier rows. The other forges, the draft-arm refusal's sidecar, and "a failed lookup emits nothing" are the not-applicable and covered rows in WP-12. `fm-merge-outcome-lib.sh` is the at-least-once row.

### bin/backends — not applicable, pane backends

`cmux.sh`, `hc.sh`, `herdr.sh`, `herdr-agent-view.py`, `herdr-eventwait.py`, `herdr-workspace-move.py`, `orca.sh`, `paseo.sh`, `rex.sh`, `rex-eventwait.lua`, `t3code.sh`, `tern.sh`, `tmux.sh`, `zellij.sh`.

### bin, not applicable

Pane, harness, home, fleet, secondmate, relay, or firstmate's own tooling. None of these is a WP-10, WP-11, WP-12 or WP-14 rule.

- Afk and away: `fm-afk-contract.sh`, `fm-afk-launch.sh`, `fm-afk-return.sh`, `fm-afk-start.sh`
- Harness trust and stop hooks: `fm-agy-trust.sh`, `fm-claude-account-quota.sh`, `fm-claude-stop-autoarm.sh`, `fm-claude-trust.sh`, `fm-codex-stop-park.sh`, `fm-kimi-trust-lib.sh`, `fm-kimi-turnend-hook.sh`, `fm-hermes-hook.sh`, `fm-hermes-lib.sh`, `fm-hermes-process-lib.sh`
- Approval failover and pretool checks: `fm-approval-failover.sh`, `fm-arm-command-policy.mjs`, `fm-arm-pretool-check.sh`, `fm-cd-command-policy.mjs`, `fm-cd-pretool-check.sh`, `fm-subagent-pretool-check.sh`
- Backends and home tags: `fm-backend.sh`, `fm-backend-hometag-lib.sh`
- Backlog and bearings: `fm-backlog-handoff.sh`, `fm-backlog-receive.sh`, `fm-backlog-transition-lib.sh`, `fm-bearings-board.sh`, `fm-bearings-snapshot.sh`
- Bootstrap and config: `fm-bootstrap.sh`, `fm-config-inherit-lib.sh`, `fm-config-push.sh`, `fm-home-seed.sh`, `fm-home-summary-refresh.sh`
- Branch supervision: `fm-branch-dispatch.mjs`, `fm-branch-outcome.sh`, `fm-branch-prompt.sh`, `fm-branch-report.sh`
- Busy and capacity: `fm-busy-event.sh`, `fm-busy-lib.sh`, `fm-capacity.sh`, `fm-project-capacity-lib.sh`
- Captain hold (backlog, not the decision table): `fm-captain-hold.sh`, `fm-hold-reason-lib.sh`
- Custom checks and trust hashes: `fm-check-lib.sh`, `fm-check-register.sh`, `fm-check-unregister.sh`
- Harness plugins: `fm-commandcode-mod.ts`, `fm-composer-lib.sh`, `fm-cortex-plugin.sh`, `fm-cursor-lib.sh`, `fm-devin-config.sh`, `fm-gemini-lib.sh`, `fm-omp-profile-lib.sh`, `fm-polytoken-lib.sh`
- Control and dispatch: `fm-control.sh`, `fm-control-lib.sh`, `fm-dispatch-resolve.sh`, `fm-crew-state.sh`
- Docs and contributions: `fm-doc-audience-check.sh`, `fm-contributions.sh`, `fm-contributions.jq`
- Environment, credentials, tool exclusion at spawn: `fm-env-lib.sh`, `fm-credential-source-lib.sh`, `fm-exclude-tools-lib.sh` (Hivra's read-only launch is the covered row, not this config file)
- Calm extension: `fm-extension.sh`, `fm-extension.mjs`, `fm-extension-launch-barrier.mjs`, `fm-operational-input.sh`
- External review forge: `fm-external-review-lib.sh`, `fm-review-check.sh`, `fm-review-diff.sh`
- Fast-forward and fleet: `fm-ff-lib.sh`, `fm-fleet-ledger.sh`, `fm-fleet-snapshot.sh`, `fm-fleet-sync.sh`, `fm-fleet-view.sh`
- Forge detect and other forges: `fm-forge-detect.sh`
- Git helpers that are not the merge path: `fm-git-strip-ai-trailers.sh`
- Process guard and harness entry: `fm-guard.sh`, `fm-harness.sh`
- Herdr and hc labs and cleanup: `fm-hc-ci-cleanup.sh`, `fm-hc-lab.sh`, `fm-herdr-ci-cleanup.sh`, `fm-herdr-groups.sh`, `fm-herdr-lab.sh`, `fm-herdr-lab-viewer.py`, `fm-herdr-session-cleanup.sh`
- Hook host and mirror: `fm-hook-host-lib.sh`, `fm-host-mirror.sh`, `fm-inactive-reconcile.sh`
- Installers: `fm-install-actionlint.sh`, `fm-install-hc.sh`, `fm-install-herdr.sh`, `fm-install-shellcheck.sh`, `fm-install-treehouse.sh`
- Memory guard: `fm-jev-mem-guard.sh`, `fm-jev-mem-guard.py`
- Labs, leases, locks: `fm-lab-home.sh`, `fm-lease.sh`, `fm-lease-lib.sh`, `fm-lock.sh`, `fm-lock-lib.sh`, `fm-session-lock-lib.sh`
- Lint and line caps: `fm-lint.sh`, `fm-lint-workflows.sh`, `fm-line-cap-lib.sh`, `fm-live-lab.sh`
- Mail: `fm-mail.sh`, `fm-mail.py`, `fm-mail-check.sh`
- Markers, on-switch, paths: `fm-marker-lib.sh`, `fm-on.sh`, `fm-path-lib.sh`
- No-mistakes runner: `fm-nm-run-lib.sh`
- Parent channel and primary-home marker: `fm-parent-channel-lib.sh`, `fm-primary-scope-lib.sh` (a home marker, not the worker isolation check)
- Peek, pipeline spend, promote: `fm-peek.sh`, `fm-pipeline-spend.sh`, `fm-promote.sh`
- Process events: `fm-procevent.sh`, `fm-procevent-lib.sh`, `fm-procevent-extension-capture.pl`, `fm-procevent-lavish.sh`, `fm-procevent-quota.sh`, `fm-procevent-remote-reply.sh`, `fm-procevent-when.sh`
- Project origin and push transition: `fm-project-origin-lib.sh`, `fm-push-transition-lib.sh`
- Public follow-up and X/Twitter: `fm-public-followup.sh`, `fm-public-followup-collect.sh`, `fm-public-followup-emit.sh`, `fm-public-followup-lib.sh`, `fm-x-dismiss.sh`, `fm-x-followup.sh`, `fm-x-lib.sh`, `fm-x-link.sh`, `fm-x-poll.sh`, `fm-x-reply.sh`
- Quota: `fm-quota-axi-lib.sh`, `fm-quota-choose.sh`
- Record export: `fm-record-export.sh`, `fm-record-export.py`
- Remote secondmates and jobs: `fm-remote-delta-read.sh`, `fm-remote-doctor.sh`, `fm-remote-entrypoint.sh`, `fm-remote-file.sh`, `fm-remote-herdr-guard.sh`, `fm-remote-herdr-owner-lib.sh`, `fm-remote-home-provision.sh`, `fm-remote-home-seed.sh`, `fm-remote-inherit.sh`, `fm-remote-inherit-push.sh`, `fm-remote-job-lib.sh`, `fm-remote-job-reap-orphans.sh`, `fm-remote-job-worker.sh`, `fm-remote-readiness-lib.sh`, `fm-remote-secondmate-control.sh`, `fm-remote-secondmate-relaunch.sh`
- Roles: `fm-role.sh`, `fm-role-lib.sh`
- Secondmates: `fm-secondmate-charter-lib.sh`, `fm-secondmate-liveness-lib.sh`, `fm-secondmate-nudge-lib.sh`, `fm-secondmate-parent-lib.sh`, `fm-secondmate-reconcile.sh`, `fm-secondmate-registry-lib.sh`, `fm-secondmate-report.sh`, `fm-secondmate-restart.sh`, `fm-secondmate-restart-lib.sh`
- Session start: `fm-session-start.sh`, `fm-sessionstart-agy.sh`, `fm-sessionstart-cursor.sh`, `fm-sessionstart-nudge.sh`, `fm-sessionstart-run.sh`
- Spawn and startup: `fm-spawn.sh`, `fm-startup-growth-check.sh`, `fm-startup-memory-budget.sh`, `fm-startup-memory-budget-lib.sh`, `fm-startup-network.sh`
- Stow: `fm-stow-cascade.sh`
- Supervision host: `fm-supervise-daemon.sh`, `fm-supervision-engine-lib.sh`, `fm-supervision-handoff.sh`, `fm-supervision-host.sh`, `fm-supervision-instructions.sh`, `fm-supervision-lib.sh`, `fm-supervisor-target-lib.sh`
- t3code answers: `fm-t3-answer.sh`, `fm-t3-mcp.mjs`, `fm-t3code-codex-env.sh`
- Tangle, tasks, timeouts, timing, tmux: `fm-tangle-lib.sh`, `fm-tasks-axi.sh`, `fm-tasks-axi-lib.sh`, `fm-timeout-lib.sh`, `fm-timing-lib.sh`, `fm-tmux-lib.sh`
- Tooling: `fm-test-isolation-proof.sh`, `fm-test-run.sh`, `fm-test-tap-verify.sh`, `fm-tool-update-check.sh`, `fm-trace-context-lib.sh`, `fm-transition-lib.sh`
- Turn-end guards: `fm-turnend-guard.sh`, `fm-turnend-guard-agy.sh`, `fm-turnend-guard-cursor.sh`, `fm-turnend-guard-grok.sh`
- Self-update and usage warner: `fm-update.sh`, `fm-usage-warner.sh`, `fm-vendor-auth-probe.sh`
- Voice relay: `fm-voice-client.py`, `fm-voice-relay.py`, `fm_voice_frame.py`, `fm_voice_records.py`
- Warm compact, worker accounts, rex marks: `fm-warm-compact-lib.sh`, `fm-worker-account-lib.sh`, `fm-rex-marks.sh`
- Process listing: `fm-agent-process-lib.sh`

### tests, judged in the tables

`fm-brief.test.sh`, `fm-dod-lib.test.sh`, `fm-classify-corr-token.test.sh`, `fm-classify-decision-key.test.sh`, `fm-watch-arm.test.sh`, `fm-watch-checkpoint.test.sh`, `fm-watch-inbox-meta.test.sh`, `fm-watch-open-decisions.test.sh`, `fm-watch-recovery-loop.test.sh`, `fm-watch-triage.test.sh`, `fm-watch-triage-pause.test.sh`, `fm-watch-triage-wedge-defer.test.sh`, `fm-watch-wedge-cap.test.sh`, `fm-watch-wedge-cap-live.test.sh`, `fm-watch-wedge-cap-unconfigured-parity.test.sh`, `fm-watcher-lock.test.sh`, `fm-wake-queue.test.sh`, `fm-wake-drain-open-decisions.test.sh`, `fm-wake-drain-open-decisions-cursor.test.sh`, `fm-wake-drain-outcome-backstop.test.sh`, `fm-wake-drain-unread-status.test.sh`, `fm-wake-daemon-lifecycle-e2e.test.sh`, `fm-pr-merge.test.sh`, `fm-pr-check-security.test.sh`, `fm-pr-health.test.sh`, `fm-pr-reviewers.test.sh`, `fm-pr-state.test.sh`, `fm-pr-state-live-e2e.test.sh`, `fm-teardown.test.sh`, `fm-teardown-endpoint-safety.test.sh`, `fm-task-delivery.test.sh`, `fm-inbox.test.sh`, `fm-task-inbox.test.sh`, `fm-gate-refuse.test.sh`, `fm-merge-local.test.sh`, `fm-project-mode.test.sh`, `fm-ensure-agents-md.test.sh`, `fm-git-push-guard.test.sh`, `fm-pending-reply.test.sh`, `fm-send-agy-confirm.test.sh`, `fm-send-inbox.test.sh`, `fm-send-inbox-doorbell-live-e2e.test.sh`, `fm-send-kiro-confirm.test.sh`, `fm-send-popup-settle.test.sh`, `fm-send-remote-delivery.test.sh`, `fm-send-resolve-key.test.sh`, `fm-send-secondmate-marker.test.sh`, `fm-send-secondmate-marker-herdr-e2e.test.sh`, `fm-send-settle.test.sh`, `fm-send-strict.test.sh`.

### tests, not applicable

The rest of `tests/` drives a backend, a harness, a secondmate, the fleet, away mode, or firstmate's own CI. Fixtures and captures are inputs to those tests.

- Helpers and fixtures: `fixtures.sh`, `lib.sh`, `git-config-helpers.sh`, `wake-helpers.sh`, `watch-triage-helpers.sh`, `secondmate-helpers.sh`, `supervision-host-helpers.sh`, `cmux-test-safety.sh`, `hc-test-safety.sh`, `herdr-test-safety.sh`, `herdr-client-pair-fixture.sh`, `rex-test-safety.sh`, `rex-fake-fixture.sh`, `remote-herdr-fixture.sh`, `tern-test-safety.sh`, `zellij-test-safety.sh`, `t3-fake-lib.sh`, `t3-fake-server.mjs`, `opencode-v2-live-fixture.py`, `assets/board-render-harness.mjs`, `fixtures/fm-read-repetition-live.mjs`, `fixtures/fm-read-repetition-sdk.mjs`, and the `fixtures/opencode-1.18.31-cwd/`, `fixtures/rex-opencode-1.19.3/`, `captures/kimi-code-2.3.0/` and `captures/no-mistakes-v1.70.1/` files (pane captures and toon fixtures).
- Afk: `fm-afk-contract.test.sh`, `fm-afk-inject-e2e.test.sh`, `fm-afk-inject-herdr-e2e.test.sh`, `fm-afk-launch.test.sh`, `fm-afk-pi-herdr-return-e2e.test.sh`, `fm-afk-return.test.sh`
- Backends: `fm-backend.test.sh`, `fm-backend-autodetect-smoke.test.sh`, `fm-backend-cmux.test.sh`, `fm-backend-cmux-smoke.test.sh`, `fm-backend-hc.test.sh`, `fm-backend-hc-smoke.test.sh`, `fm-backend-hc-appdetect-smoke.test.sh`, `fm-backend-hc-liveness-live-e2e.test.sh`, `fm-backend-herdr.test.sh`, `fm-backend-herdr-smoke.test.sh`, `fm-backend-herdr-agent-exit-shell-e2e.test.sh`, `fm-backend-herdr-eventwait.test.py`, `fm-backend-herdr-eventwait-smoke.test.sh`, `fm-backend-herdr-focus-flash-e2e.test.sh`, `fm-backend-herdr-launcher-workspace-e2e.test.sh`, `fm-backend-herdr-presentation-e2e.test.sh`, `fm-backend-herdr-prune-safety-e2e.test.sh`, `fm-backend-herdr-respawn-idem-e2e.test.sh`, `fm-backend-herdr-stale-active-tab-e2e.test.sh`, `fm-backend-herdr-workspace-per-home-e2e.test.sh`, `fm-backend-orca.test.sh`, `fm-backend-paseo.test.sh`, `fm-backend-paseo-smoke.test.sh`, `fm-backend-rex.test.sh`, `fm-backend-rex-smoke.test.sh`, `fm-backend-rex-composer-live-e2e.test.sh`, `fm-backend-rex-eventwait-smoke.test.sh`, `fm-backend-t3code.test.sh`, `fm-backend-t3code-live-e2e.test.sh`, `fm-backend-t3code-pr-tools-live-e2e.test.sh`, `fm-backend-tern.test.sh`, `fm-backend-tern-smoke.test.sh`, `fm-backend-tmux-smoke.test.sh`, `fm-backend-zellij.test.sh`, `fm-backend-zellij-smoke.test.sh`
- Harness adapters and their live checks: `fm-agy-harness.test.sh`, `fm-agy-primary.test.sh`, `fm-agy-primary-live-e2e.test.sh`, `fm-agy-signals-live-e2e.test.sh`, `fm-claude-account-quota.test.sh`, `fm-claude-stop-autoarm.test.sh`, `fm-claude-stop-autoarm-live-e2e.test.sh`, `fm-claude-trust.test.sh`, `fm-codex-continuity-live-e2e.test.sh`, `fm-codex-hook-layer-live-e2e.test.sh`, `fm-codex-stop-park.test.sh`, `fm-commandcode-harness.test.sh`, `fm-commandcode-signals-live-e2e.test.sh`, `fm-cortex-harness.test.sh`, `fm-cortex-signals-live-e2e.test.sh`, `fm-cursor-harness.test.sh`, `fm-cursor-primary.test.sh`, `fm-cursor-primary-live-e2e.test.sh`, `fm-devin-harness.test.sh`, `fm-devin-signals-live-e2e.test.sh`, `fm-gemini-harness.test.sh`, `fm-grok-harness.test.sh`, `fm-grok-continuity-live-e2e.test.sh`, `fm-grok-stop-live-e2e.test.sh`, `fm-hermes-harness.test.sh`, `fm-hermes-gateway-coexistence-live-e2e.test.sh`, `fm-hermes-profile-safety-live-e2e.test.sh`, `fm-hermes-signals-live-e2e.test.sh`, `fm-kimi-harness.test.sh`, `fm-kimi-trust-prompt-live-e2e.test.sh`, `fm-kiro-harness.test.sh`, `fm-kiro-signals-live-e2e.test.sh`, `fm-muse-harness.test.sh`, `fm-muse-signals-live-e2e.test.sh`, `fm-omp-harness.test.sh`, `fm-omp-primary-live-e2e.test.sh`, `fm-opencode-abs-cwd-rail-live-e2e.test.sh`, `fm-opencode-primary-live-e2e.test.sh`, `fm-pi-branch-extension.test.sh`, `fm-pi-branch-live-e2e.test.sh`, `fm-pi-branch-responsiveness-live-e2e.test.sh`, `fm-pi-codex-native.test.sh`, `fm-pi-primary-live-e2e.test.sh`, `fm-pi-primary-types.test.sh`, `fm-pi-seeded-home-trust-live-e2e.test.sh`, `fm-pi-watch-extension.test.sh`, `fm-pi-windows-shell-invocation.test.sh`, `fm-pi-worker-stream-live-e2e.test.sh`, `fm-pi-worker-stream-live.mjs`, `fm-polytoken-harness.test.sh`, `fm-polytoken-signals-live-e2e.test.sh`, `fm-rovo-harness.test.sh`, `fm-rovo-signals-live-e2e.test.sh`
- Calm mode: `fm-calm-claude-mod.test.sh`, `fm-calm-claude-mod-live-e2e.test.sh`, `fm-calm-claude-mod-plugin.test.sh`, `fm-calm-pi-extension.test.sh`, `fm-calm-pi-queue-retention-live-e2e.test.sh`
- Fleet, backlog, bearings, capacity: `fm-backlog-atomicity.test.sh`, `fm-backlog-handoff.test.sh`, `fm-backlog-read-bound.test.sh`, `fm-bearings-board.test.sh`, `fm-bearings-board-render.test.sh`, `fm-bearings-board-lavish-live-e2e.test.sh`, `fm-bearings-snapshot.test.sh`, `fm-capacity.test.sh`, `fm-fleet-ledger.test.sh`, `fm-fleet-snapshot-contribution-input.test.sh`, `fm-fleet-snapshot-view.test.sh`, `fm-fleet-sync.test.sh`, `fm-contributions.test.sh`, `fm-captain-hold-lifecycle.test.sh`
- Secondmates and remote jobs: `fm-secondmate-busy-contract-live-e2e.test.sh`, `fm-secondmate-harness.test.sh`, `fm-secondmate-lifecycle-e2e.test.sh`, `fm-secondmate-liveness.test.sh`, `fm-secondmate-reconcile.test.sh`, `fm-secondmate-restart.test.sh`, `fm-secondmate-safety.test.sh`, `fm-secondmate-sync.test.sh`, `fm-remote-backlog-handoff.test.sh`, `fm-remote-delta-read.test.sh`, `fm-remote-doctor.test.sh`, `fm-remote-entrypoint.test.sh`, `fm-remote-herdr-guard.test.sh`, `fm-remote-job.test.sh`, `fm-remote-job-claim-reap.test.sh`, `fm-remote-job-claim-retention.test.sh`, `fm-remote-job-launchagent.test.sh`, `fm-remote-job-orphan-reap.test.sh`, `fm-remote-job-process-start.test.sh`, `fm-remote-reply.test.sh`, `fm-remote-secondmate-lifecycle-e2e.test.sh`, `fm-remote-secondmate-omp.test.sh`, `fm-remote-secondmate-parent-binding.test.sh`, `fm-remote-secondmate-relaunch.test.sh`, `fm-remote-secondmate-trace-context.test.sh`, `fm-remote-transport-lanes.test.sh`, `fm-peek-remote.test.sh`, `fm-parent-channel-scan-exclusion.test.sh`
- Supervision host, spawn, session start: `fm-supervision-events.test.sh`, `fm-supervision-host.test.sh`, `fm-supervision-host-attended-live-e2e.test.sh`, `fm-supervision-host-drain.test.sh`, `fm-supervision-host-hook.test.sh`, `fm-supervision-host-live-e2e.test.sh`, `fm-supervision-host-park.test.sh`, `fm-supervision-instructions.test.sh`, `fm-spawn-batch.test.sh`, `fm-spawn-compact-adviser-disable.test.sh`, `fm-spawn-compact-adviser-disable-remote.test.sh`, `fm-spawn-dispatch-profile.test.sh`, `fm-spawn-external-review.test.sh`, `fm-spawn-herdr-lease.test.sh`, `fm-spawn-manual-pr-text.test.sh`, `fm-spawn-orca-worktree.test.sh`, `fm-spawn-pool-base-freshen.test.sh`, `fm-spawn-worktree-settle.test.sh`, `fm-session-start.test.sh`, `fm-session-lock-ancestry.test.sh`, `fm-session-lock-windows-consumers.test.sh`, `fm-sessionstart-hook-live-e2e.test.sh`, `fm-sessionstart-instruction-refresh-live-e2e.test.sh`, `fm-sessionstart-nudge.test.sh`
- Everything else in `tests/` is the same kind of thing: `fm-approval-failover.test.sh`, `fm-arm-pretool-check.test.sh`, `fm-ask-user-authority.test.sh`, `fm-assertions.test.sh`, `fm-bootstrap.test.sh`, `fm-bootstrap-network-parallel.test.sh`, `fm-branch-supervision.test.sh`, `fm-busy-adapter-wiring.test.sh`, `fm-busy-state.test.sh`, `fm-cd-pretool-check.test.sh`, `fm-check-unregister.test.sh`, `fm-ci-workflow.test.sh`, `fm-cmux-claude-composer-live-e2e.test.sh`, `fm-composer-codex-idle-live-e2e.test.sh`, `fm-composer-ghost.test.sh`, `fm-composer-lib.test.sh`, `fm-composer-matrix-live-e2e.test.sh`, `fm-control.test.sh`, `fm-control-herdr-smoke.test.sh`, `fm-control-relaunch.test.sh`, `fm-crew-state.test.sh`, `fm-daemon.test.sh`, `fm-dispatch-resolve.test.sh`, `fm-documentation-audiences.test.sh`, `fm-extension-binding.test.sh`, `fm-forge-detect.test.sh`, `fm-fork-free-helpers.test.sh`, `fm-git-strip-ai-trailers.test.sh`, `fm-gitignore-config.test.sh`, `fm-gotmp.test.sh`, `fm-guard-stale-banner.test.sh`, `fm-harness-adapter-instructions-live-e2e.test.sh`, `fm-harness-adapter-references.test.sh`, `fm-harness-liveness-drift-live-e2e.test.sh`, `fm-harness-precedence.test.sh`, `fm-hc-lab.test.sh`, `fm-herdr-attached-viewer-live-e2e.test.sh`, `fm-herdr-groups.test.sh`, `fm-herdr-lab.test.sh`, `fm-herdr-pi-stale-registration-live-e2e.test.sh`, `fm-herdr-session-cleanup.test.sh`, `fm-herdr-session-cleanup-e2e.test.sh`, `fm-herdr-submit-confirm-live-e2e.test.sh`, `fm-herdr-version-floor-live-e2e.test.sh`, `fm-home-summary-refresh.test.sh`, `fm-host-mirror.test.sh`, `fm-host-mirror-live-e2e.test.sh`, `fm-inactive-reconcile.test.sh`, `fm-jev-mem-guard.test.sh`, `fm-launch-prompt-signals-live-e2e.test.sh`, `fm-lint.test.sh`, `fm-lint-workflows.test.sh`, `fm-live-gate.test.sh`, `fm-live-lab.test.sh`, `fm-live-lab-isolation.test.sh`, `fm-live-lab-up-mate.test.sh`, `fm-mail.test.sh`, `fm-mail-check.test.sh`, `fm-nm-test-contract.test.sh`, `fm-no-mistakes-required.test.sh`, `fm-on.test.sh`, `fm-operational-input.test.sh`, `fm-pipeline-spend.test.sh`, `fm-procevent.test.sh`, `fm-procevent-extension-errors.test.sh`, `fm-procevent-quota.test.sh`, `fm-procevent-when.test.sh`, `fm-project-capacity.test.sh`, `fm-project-origin.test.sh`, `fm-public-followup.test.sh`, `fm-quota-array-dispatch-live-e2e.test.sh`, `fm-quota-choose.test.sh`, `fm-read-repetition.test.sh`, `fm-read-repetition-live.test.sh`, `fm-record-export.test.sh`, `fm-record-export-remote-home.test.sh`, `fm-review-check.test.sh`, `fm-review-diff.test.sh`, `fm-self-repo-role.test.sh`, `fm-shared-captain-inheritance.test.sh`, `fm-startup-growth-check.test.sh`, `fm-startup-memory-budget.test.sh`, `fm-startup-network.test.sh`, `fm-stat-shadowing.test.sh`, `fm-stow-cascade.test.sh`, `fm-subagent-pretool-check.test.sh`, `fm-t3-mcp.test.sh`, `fm-tangle-guard.test.sh`, `fm-tasks-axi.test.sh`, `fm-test-fixture-cleanup.test.sh`, `fm-test-fixtures.test.sh`, `fm-test-isolation-proof.test.sh`, `fm-test-run.test.sh`, `fm-test-tap-verify.test.sh`, `fm-timeout-lib.test.sh`, `fm-tmux-agent-liveness.test.sh`, `fm-tmux-submit-busy.test.sh`, `fm-tool-update-check.test.sh`, `fm-trace-context-lib.test.sh`, `fm-trace-context-spawn.test.sh`, `fm-transition-lib.test.sh`, `fm-turnend-foreign-owner-arm-fix.test.sh`, `fm-turnend-foreign-owner-repro.py`, `fm-turnend-guard.test.sh`, `fm-update.test.sh`, `fm-usage-warner.test.sh`, `fm-vendor-auth-probe.test.sh`, `fm-voice-relay.test.sh`, `fm-warm-compact.test.sh`, `fm-warm-compact-herdr-live-e2e.test.sh`, `fm-worker-account.test.sh`, `fm-worker-account-live-e2e.test.sh`, `fm-x-mode.test.sh`.

### docs — not applicable

Each doc explains a script family already judged, or a backend. `docs/watcher-continuity.md` is the shell watcher's re-arm contract (the arm and checkpoint rows). `docs/architecture.md` describes the home, not a Hivra package.

`agent-control.md`, `arm-pretool-check.md`, `calm.md`, `calm-mode-feasibility.md`, `captain-hold-lifecycle.md`, `cd-guard.md`, `cmux-backend.md`, `codex-app-backend.md`, `configuration.md`, `documentation-audiences.md`, `documentation-audiences.json`, `extension-bindings.md`, `external-review-forge.md`, `fleet-ledger.md`, `fm-test-isolation-proof.md`, `fm-test-isolation-proof.json`, `fm-test-portable-shards.md`, `forgejo-tea-integration.md`, `gerrit-change-watch.md`, `gerrit-forge-integration.md`, `gitlab-merge-watch.md`, `hc-backend.md`, `herdr-backend.md`, `jev-guards.md`, `opencode-2-plugin-port-scope.md`, `orca-backend.md`, `paseo-backend.md`, `pi-supervision-branch.md`, `pi-supervision-branch-poster.svg`, `remote-secondmates.md`, `rex-backend.md`, `scripts.md`, `secondmate-parent-channel.md`, `sessionstart-nudge.md`, `subagent-guard.md`, `supervision-host.md`, `t3code-backend.md`, `tern-backend.md`, `tmux-backend.md`, `trace-context.md`, `turnend-guard.md`, `usage-warner.md`, `voice-relay.md`, `watcher-continuity.md`, `wedge-alarm.md`, `zellij-backend.md`, `architecture.md`, `plans/2026-10-12-2032-feat-pi-stream-silence-plan.md`, `examples/crew-dispatch.json`, `examples/watched-tools.json`, `examples/process-event-extension/file-signal.mjs`, `examples/process-event-extension/firstmate-extension.json`, `examples/usage-warner`, `examples/wedge-alarm`, `supervision-protocols/` (`agy.md`, `claude.md`, `codex.md`, `codex-checkpoint.md`, `cursor.md`, `grok.md`, `omp.md`, `opencode.md`, `pi.md`, `supervision-host.md`, `unknown.md`), `verification/` (`agy.md`, `commandcode.md`, `cortex.md`, `devin.md`, `dispatch-auth.md`, `dispatch-resolve.md`, `hermes.md`, `kiro.md`, `lint-option-a.md`, `muse.md`, `polytoken.md`, `process-event-sources.md`, `public-followup.md`, `rovo.md`, `runtime-backends.md`, `secondmate-parent-channel.md`, `stow-memory.md`, `supervision.md`, `trace-context.md`).

### skills — not applicable

`skills/stow/SKILL.md` is memory stow (another package). `.agents/skills/` is the same set of skills firstmate loads for itself: `afk`, `agent-skill-trigger-index`, `ahoy`, `ask-user-authority`, `away-quiet-supervision`, `bearings` (and `bearings/assets/board-template.html`), `bootstrap-diagnostics`, `captain-hold-lifecycle`, `diagnostic-reasoning`, `firstmate-codexapp` (and `agents/openai.yaml`), `firstmate-coding-guidelines`, `firstmate-orca`, `firstmate-self-repo`, `fmx-respond`, `harness-adapters` (and `references/common/` `control-and-recovery.md`, `dispatch.md`, `model-and-effort.md`, `primary-hooks.md`, and `references/harness/` for agy, claude, codex, commandcode, cortex, cursor, devin, gemini, grok, hermes, kimi, kiro, muse, omp, opencode, pi, polytoken, rovo), `operational-home-layout`, `process-event-sources`, `project-management`, `quiet`, `quota-array-dispatch`, `scout-completion`, `secondmate-provisioning`, `session-start-recovery`, `ship-landing`, `stow`, `stuck-crewmate-recovery`, `updatefirstmate`, `validation-supervision`. Each is a `SKILL.md` plus the files named above. `.agents/hooks.json` is the skill hook list.

### Harness plugins and CI — not applicable

- `.claude/settings.json`, `.claude/skills` (a link to `.agents/skills`), `.claude/mods/firstmate-calm/` (`hooks/hooks.json`, `hooks/register.ts`, `lib/fm-branch-notes.ts`, `lib/fm-calm-presentation.ts`, `lib/fm-calm-preservation.ts`, `lib/fm-calm-ship-raster.ts`, `lib/fm-calm-working-ship-sprite.ts`, `lib/fm-operational-input.ts`, `tests/branch-notes.test.ts`, `tests/calm.test.ts`, `tests/support.ts`, `tests/working-ship.test.ts`). Calm-mode presentation.
- `.codex/hooks.json`, `.cursor/hooks.json`. Hook wiring.
- `.github/workflows/ci.yml`, `no-mistakes-required.yml`, `windows-herdr-spike.yml`. firstmate's own CI.
- `.greptile/rules.md`. Review-bot notes.
- `.claude/mods/firstmate-calm/.claude-plugin/plugin.json`. Plugin manifest.
- `.grok/hooks/` (`fm-primary-cd-check.json`, `fm-primary-pretool-check.json`, `fm-primary-sessionstart-nudge.json`, `fm-primary-turnend-guard.json`). Grok hooks.
- `.omp/fm-worker-overlay.yml` and `.omp/extensions/` (`fm-primary-omp-watch.ts`, `fm-primary-turnend-guard.ts`). omp pane.
- `.opencode/plugins/` (`fm-primary-cd-check.js`, `fm-primary-pretool-check.js`, `fm-primary-sessionstart-nudge.js`, `fm-primary-turnend-guard.js`, `fm-primary-watch-arm.js`, `package.json`, `lib/fm-opencode2.js`, `lib/fm-operational-input.js`). OpenCode plugin.
- `.pi/extensions/` (`fm-branch-supervision.ts`, `fm-calm.ts`, `fm-primary-pi-watch.ts`, `fm-primary-read-repetition.ts`, `fm-primary-turnend-guard.ts`, and `lib/` `fm-async-exec.ts`, `fm-branch-dispatch.ts`, `fm-branch-model-picker.ts`, `fm-calm-assistant-layout.ts`, `fm-calm-operational-user-layout.ts`, `fm-calm-pending-operational-layout.ts`, `fm-calm-preservation.ts`, `fm-calm-visibility.ts`, `fm-calm-working-ship.ts`, `fm-calm-working-ship-sprite.ts`, `fm-native-contract.ts`, `fm-operational-input.ts`, `fm-primary-read-repetition-policy.ts`, `fm-sessionstart-supervisor.mjs`). Pi extensions. Two of the calm files are links to the Claude mod.

# WP-84: research, plan, then build

A costly task no longer starts a coding worker first. The first mate runs research, then a design discussion, and waits. "Looks right" continues. A small task still goes straight to code.

## What changed

- The phase skills are a default plugin, `hivra-rpi`, at `src-tauri/plugins/hivra-rpi`. HumanLayer's text is copied from `apps/riptide-rpi-claude-plugin` at `f9bd73534a9fb7099a274f951b698b1297122fd9` (Apache-2.0). Matt Pocock's `diagnosing-bugs`, `tdd` and `grill-me` are copied from `mattpocock/skills` at `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` (MIT).
- Matt's tdd is the folder `rpi-tdd`. pstack already ships `tdd`, and a skill link is skipped when the name exists, so the two would otherwise collide.
- Left out: `ci-commit`, `configure-workspaces`, `setup-worktree` (Hivra has its own), and `oneshot` (a straight build is the crew path the app already has, not a skill run).
- Linear ticket wording is a Hivra task. `.humanlayer/tasks/<slug>/` is `the task's folder`. Slash commands are "the first mate runs this phase". `LinearService` in a research example is a code name, not a ticket, and stays.
- The stub at `plugins/hivra-rpi` is deleted. Node tests read `src-tauri/plugins/hivra-rpi`.
- Each phase is a worker on the same start path as a coding worker (`host.start` with no delegation meta, so it is not a review row). The reply is the document. A failure with no text is not finished, and a timeout does not move the phase on.
- The launcher stays after the opening ask returns. "Looks right" on the task starts the next phase. Dropping the launcher there made that answer look like the crew was gone.
- Credits, the README Inspirations list and the root NOTICE name HumanLayer and Matt Pocock, not Ash.

## Done when

- A small task takes the straight path and no phase documents are written. `machine.test.ts` "sends a small task straight through and writes no phase document". `agentAppTasks.test.ts` "holds a hard task until the phase documents are accepted, and still starts a usual one".
- A phased task writes research, then design, then waits. `machine.test.ts` and `store.test.ts` "writes research, then design, and waits". The hold test starts two phase workers (research questions, then research) and no coding worker.
- "Change this" runs the iterate skill on the same document. `machine.test.ts` "runs the iterate skill on the same document when the person says change this".
- A comment on the design document reaches the next run. `machine.test.ts` "carries a comment on the design document into the next run".
- The RPI skills are not in the always-on skill index. `indexGuard.test.ts` "keeps every research skill out of the always-on index". Each skill has `disable-model-invocation: true`. With pstack switched off, Claude and Codex still see `rpi-tdd` and not pstack's `tdd` (`pstackSessions.test.ts`).
- The PR links the phase documents. `pr.test.ts` "links the research and design documents, and adds nothing for a straight build".
- Browser spec: `tests/browser/phases.spec.ts` "a phased task shows its documents and the decision". Chromium passed. WebKit did not run (below).
- `npm run check`: vitest 1184 files, 9601 passed, 13 skipped. `tsc --noEmit` reported no errors (the script tests started after it). Script tests: 358 passed, 0 failed, 2 skipped. `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` completed, because `cargo test` ran after them in the same command. That `cargo test` log was cut off by the tool after the lib suite (1789 passed). A follow-up `cargo test --workspace --offline` reported 1821 passed, 2 ignored.
- Dev copy, fake Claude, through the app path: `agentAppTasks.test.ts` "walks research, plan and build to done with the fake Claude". Five phase starts, documents for research questions, research, design, outline and build, then a coding worker. This does not boot Tauri.

## Commands

- `npx vitest run` (inside `npm run check`): 9601 passed, 13 skipped. Two earlier runs failed and were fixed: credits README/NOTICE still said the skills were rewritten, and `skillBody.ts` used `Array.prototype.at`, which this `tsconfig` lib does not have.
- `npx playwright test tests/browser/phases.spec.ts --project=chromium --project=webkit`: Chromium passed. WebKit failed before launch: `Executable doesn't exist at ~/Library/Caches/ms-playwright/webkit-2359/pw_run.sh`. `npx playwright install webkit` was not run; it needs a network download.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib plugins::defaults_tests`: 9 passed, including the pstack wiring snapshot.
- `cargo test --manifest-path src-tauri/Cargo.toml --workspace --offline`: 1821 passed, 2 ignored.

## Not checked

- No Tauri window and no `npm run hub:dev`. The finish hook in `App.tsx` is covered by the unit walk only as far as `deliverPhaseResult`; the test fixture calls that itself.
- `src-tauri/src/control.rs` answers an app call within 35 seconds (`recv_timeout(Duration::from_secs(35))`). A phase chain can outlive that. The JS promise keeps running, and the same phase run is de-duplicated. A later retry with a new request id can still start a second coding worker once `building` is true, because that worker's id is `app-<source id>-<request id>`.
- A session id is a phase session when it contains `-phase-`. A request id of `phase-1` would match too.
- `create-plan` and `iterate-plan` still tell the worker to read `.humanlayer/workspace.json`. That is not a task path. Hivra does not ship HumanLayer's workspace setup. A missing file is the skill's own "disabled" branch.
- The pin's copyright string is the Apache appendix placeholder `Copyright [yyyy] [name of copyright owner]`. The plugin default test requires the vendored LICENSE to contain the pin's copyright, and that LICENSE has no filled-in year or owner. HumanLayer's copyright is in the plugin NOTICE, the root NOTICE and `docs/hivra/credits.json`. Matt's copyright stays on each of his skill LICENSE files. Ash's name is not on either.

## For Ash (Mac)

- Install WebKit and re-run the phase spec: `npx playwright install webkit`, then `npx playwright test tests/browser/phases.spec.ts --project=chromium --project=webkit`.
- A dev copy with the fake Claude, if you want the window path: `npm run hub:dev` in this worktree. Do not point it at the daily app.

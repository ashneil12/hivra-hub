# Chat reliability — 13 November 2026

Owner report: slow/non-streaming replies; unanswered questions disappear after background results; system envelopes leak; chat alignment and queued cards break with Overview; noisy ask count and resume duplicates; no owner completion control; completed asks clutter the active list; quotes lose source; misleading provider banner; persistent successful-update bar; idle status despite active crew; intrusive credential probe; unsupported end-to-end claims.

Worktree: `codex/chat-reliability`. Base and installed daily app: `cfcab6e2`. Includes Claude cold-start commit `ad74bb9e` (cherry-picked from `463dc9e`). Daily app/data have not been modified. Ash authorized a daily-app restart; delivery still needs the release gate resolved.

## Reproduced
- Four regression assertions failed: background reply hides question; notice acts as user answer; status recap becomes question; generated resume treated as user ask.
- Browser reproduction and screenshots: `tests/browser/chat-reliability.spec.ts`.

## Acceptance checklist
- [x] Reply text stays visible and streams before completion in recorded-event and browser tests. Real-provider latency remains unverified.
- [x] Unanswered questions survive background activity.
- [x] Recaps do not become questions.
- [x] System notices stay out of conversation prose, including stored history.
- [x] Background failure never presented as successful work.
- [x] Queued titles remain readable with Overview open.
- [x] Conversation has a comfortable centred width with Overview closed.
- [x] Resume messages do not populate ask tracking; historical noise excluded from visible active counts.
- [x] Owner can finish/dismiss/reopen asks; finished items collapsed.
- [x] Ask quote contains full original wording and stable source references.
- [x] Provider banner accurately describes direct tools versus app commands.
- [x] Successful update does not occupy persistent chat space; failures/restart actions retained.
- [x] Lead header accounts for outstanding crew work.
- [x] Worker briefs prohibit credential probing and opening a second daily app.
- [x] Tracking smoke test does not claim full workflow verification.

Each completion needs check output, screenshot or provider/native proof. Browser fixtures establish controlled UI behavior, not native/provider acceptance.

## Delivery and remaining acceptance
- [ ] Land on main and ship through the supported updater.
- [ ] Verify daily-app receipt and these workflows on the installed revision.
- [ ] Measure real-provider first-text latency. The installed Claude account reached its weekly limit; initialization measurements do not establish end-to-end response speed.

Cancelled followed briefs no longer remain in the active list. Queue cards use the scheduler's actual reason, including file collisions versus worker capacity; they do not infer a one-worker limit. Distinct active jobs with identical titles are not silently merged.

The Keychain tool-call guard covers explicit Pi shell invocations, including quoted paths/options. It supplements the brief; it is not a general-purpose shell sandbox. More-agents environment scrubbing retains no app token and gains the nonsecret agent-origin marker only after restrictions run. Mistyped/native no-command agent invocations refuse before opening a window.

## Verification record
Counts overlap between commands; do not add them as unique coverage.

| Command | Observed result |
| --- | --- |
| `npm run hub:check` | Passed; Hub identity intact; 87 Hub sessions, 6 upstream sessions. |
| `npx tsc --noEmit` | Passed after final source changes. |
| Focused Vitest command below | 21 files, 275 tests passed, no skips. Existing React act warning in DelegationBatchRow tests. |
| `node --test scripts/pi-routes-guard.test.mjs scripts/hub-dev-loop.test.cjs` | 23 passed, 0 failed/skipped. |
| `npx playwright test tests/browser/chat-reliability.spec.ts tests/browser/mono-stream.spec.ts --project=chromium` | 7 passed; light/dark at 560/1100px, streaming and Overview layout. Screenshots in `proofs/chat-reliability/`. |
| `npm run mockup:build` | Passed before and after; final 33.09s, existing >500kB chunk warning. |
| `npm run check:web` | Broad run: 1,772 files, 16,623 passed, 51 failed, 13 skipped. Midway through changes; not a release pass. |
| `npm run check:affected` | Web: 1,138 files, 10,712 passed, 36 failed, 13 skipped. Scripts: 243 passed, 2 failed, 0 skipped. Its redundant Rust stage was stopped; not a pass. |
| Unchanged-main comparison of failing web files | 46 failed, 201 passed across 28 files. 33 final affected-run failures match unchanged main exactly. Two own regressions were corrected and passed the final focused run; the HubSurface timeout also passed in that run. |
| `node --test scripts/security-review-r5repro-orig.test.mjs scripts/security-review-r5repro.test.mjs` on unchanged main | 5 passed, 2 failed, no skips: same sensitive-path classification failures. No guard weakened. |
| Earlier `npm run check:rust` | fmt/clippy passed; 5,259 Rust tests passed, 12 explicitly ignored. Predates final native launch-guard additions. |
| Later `npm run check:rust` | clippy passed; test run showed attribution-hook and process-start failures under heavy concurrent load, then stopped because source had changed. Not a final full Rust pass. |
| `cargo fmt --check` | Passed after final source changes. |
| `CARGO_BUILD_BUILD_DIR=/Users/ash/Library/Caches/monocode-hub/cargo-build cargo test --lib harness::tests::agent_provenance_reaches_a_child_after_environment_restriction -- --exact` (in src-tauri) | 1 passed, 0 failed/ignored; 5,214 unrelated tests filtered. Actual child process receives only the marker after env_clear; app token absent. |
| `npm run hub:dev -- --background` under temporary HOME | Native dev Home rendered, DEV ribbon and fresh isolated data. App stamp ad74bb9-dirty; no real keys or chats copied. Not full provider acceptance. |
| Native CLI under temporary HOME with agent marker | No command and misspelled command both exit 64 without window; `version --json` exits 0 with correct dev identity. |

Native proof HOME: `/tmp/dropwave-chat-proof.MD0Trw`. Its own dev wrapper was stopped; the daily process was not signalled. Independent review completed three rounds; accepted findings were fixed, including the final environment-clear issue. Browser fixtures use synthetic data.

The release gate remains red. `docs/testing-policy.md` says “do not push red” and a red check blocks merge. Daily restart authorization does not itself waive this gate. No push, merge, skip-tests ship, or live verification has been claimed.

### Final focused command
```sh
npx vitest run \
  src/app/ui/surfaceWidth.test.ts \
  src/features/asks/model/askNoise.test.ts \
  src/features/asks/model/quoteInChat.test.ts \
  src/features/asks/ui/ChiefGlance.asked.test.tsx \
  src/features/crew/model/briefLine.test.ts \
  src/features/firstmate/model/brief.test.ts \
  src/features/firstmate/model/leadCli.test.ts \
  src/features/firstmate/ui/LeadCliNotice.test.tsx \
  src/features/hub/model/chatQuestions.background.test.ts \
  src/features/hub/model/chatQuestions.plain.r101.test.ts \
  src/features/hub/ui/HubSurface.clean.test.ts \
  src/features/hub/ui/ShipNotice.test.ts \
  src/features/monos/model/monoCrewState.test.ts \
  src/features/monos/ui/DelegationBatchRow.test.ts \
  src/features/monos/ui/LaunchedSessionCard.r90.test.ts \
  src/features/sessions/model/transcriptActivity.test.ts \
  src/features/sessions/model/transcriptTurnCache.test.ts \
  src/features/sessions/ui/AgentTranscript.appNote.r93.test.ts \
  src/features/sessions/ui/AgentTranscript.inlineWork.test.ts \
  src/features/sessions/ui/AgentTranscript.stream.test.tsx \
  src/integrations/harness/core/credentialGuard.r69.test.ts
```

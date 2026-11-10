# WP-156: Standing answers (answer once, the crew reuses it)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Overnight alpha hunt (9 Nov 23:00 run) | M | WP-14 decisions (on main). Does not touch WP-101 or WP-146 paths | yes |

## Goal

When Ash answers a first mate's question in the Inbox, that answer becomes a **standing answer** for the project. Later first mates and crew see the relevant standing answers before they ask, and when a new question looks like one already answered, the hub hands back the old answer (with its id) instead of interrupting Ash again. Ash can retire a standing answer, and the hub then lists every task that relied on it so he can check them.

## Why

Ash wants a hub that ships like crazy without him babysitting it. Every repeated "staging or prod?" style question costs a round trip through the Inbox. Hivra's WP-14 decision gate (`src-tauri/src/decisions.rs`) already stores answers under `(project, decision_key)` and returns an answered key at once, but only when the first mate happens to reuse the **exact same key**. Nothing shows past answers to a new first mate, nothing matches a differently worded question to an old answer, and there is no retire / "who relied on this" view.

quotumorg/precedent-log (MIT, Hermes Agent plugin, created 6 Nov 2026) does exactly this for Hermes Kanban workers: save a ruling as P-1, inject active rulings into new workers' prompts (capped at 20 rows / 4,000 chars), match a new block reason against saved rulings by key words, require the worker to cite the ruling or explain why it does not apply, and keep a cited-by list so retiring P-1 shows which jobs used it. Rulings are guidance, never permission for new actions.

## Read first

- Hivra `origin/main`: `src-tauri/src/decisions.rs` (table, `ask`, `answer`, `get`, `list`), `src-tauri/src/mcp_server.rs` (the "Ask the person a decision" tool text), `src/features/firstmate/contract.md`, `src/features/firstmate/model/steering.ts`, `src/features/hub/model/localHub/decisions.ts`, the crew Inbox (`src/features/crew/model/inbox.ts`, `FirstMateInboxPanel`).
- Reference (MIT, Copyright (c) 2026 quotumorg): https://github.com/quotumorg/precedent-log at commit `c6e58a2` — `precedent_log/match.py` (normalize, key tokens, overlap score), `precedent_log/gate.py` (cite-or-explain check), `precedent_log/section.py` (prompt section with caps), `precedent_log/store.py` (append-only store, retire, cited-by). Small helpers may be translated to Rust/TS with a file header and credits; behaviour can be written fresh.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-156-standing-answers.md`. Add a `docs/hivra/SOURCES.md` row for precedent-log (MIT). If any code is translated, add the credits.json component and NOTICE line with the exact copyright line from its LICENSE (`Copyright (c) 2026 quotumorg`).
2. **Standing flag + keys.** Extend the decisions table (own `ensure_tables` style, no numbered migration) with `standing INTEGER NOT NULL DEFAULT 1`, `keys TEXT NOT NULL DEFAULT '[]'` (short match words, set by the first mate when asking or derived from the question), `retired_at`, `retired_reason`. Answered + standing + not retired = active. Tests for old rows (default standing, no keys) and retire.
3. **Show before asking.** When a first mate starts a task in a project, add a short "Standing answers" block to its brief/turn context: newest active answers for that project, capped at 20 rows and about 4,000 characters, each as `S-<n>: question -> answer`. Mark it as guidance, not permission. Tests for cap, empty project, retired rows excluded.
4. **Match on ask.** In `ask`, before creating a new open decision, score active standing answers for the project against the new question + keys (normalised word overlap, like precedent-log's `match.py`; no model call). Above a threshold, return `{ "state": "answered", "answer": ..., "standingId": "S-n", "matched": true }` and record the asker as relying on it; the first mate may re-ask with `force: true` plus a one-line reason why the old answer does not apply, which opens a fresh decision. Tests: exact key, reworded match, below-threshold miss, force path.
5. **Cited-by + retire.** Record each task that received or cited a standing answer (`decision_citations` table). In the Inbox/Decisions view, a standing answer shows its use count; **Retire** asks for a short reason, then lists the tasks that relied on it. Plain labels. Browser spec for the retire flow on Chromium + WebKit.
6. **Out of scope.** No change to who may ask (workers still go to their first mate). No auto-approval of tool calls or merges from a standing answer. No cross-project sharing in this package.

## Done when

- [ ] Answering a decision makes it a standing answer for that project by default; Ash can turn standing off per answer.
- [ ] New first mates see active standing answers (capped) in their context.
- [ ] A reworded repeat question returns the standing answer instead of a new Inbox item; `force` with a reason still asks Ash.
- [ ] Retire shows the tasks that relied on the answer.
- [ ] Scoped vitest + cargo tests for matching, caps and retire; browser spec for the UI.

## Licence

precedent-log is MIT (Copyright (c) 2026 quotumorg). Ideas and small translated helpers only, credited as above.

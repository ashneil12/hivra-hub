# WP-157: Work log and retro (what got done, what to change)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Overnight alpha hunt (9 Nov 23:00 run) | M | WP-78 activity log, WP-14 decisions, learn stores (all on main). Hooks next to WP-119 crew tree, does not rebuild it | yes |

## Goal

Hivra keeps a short **work log** per project per day: one line per finished task (outcome), per real decision, per correction Ash gave, written in plain words that still make sense a month later. Ash can ask any first mate "what got done today?" or "how did this week go?" and get an answer from the log. A weekly **retro** reads the log, names patterns (work sent back, stalls, repeated questions) and proposes concrete edits to the first mate's instructions or a project's notes, which only land after Ash accepts them through the existing learn-store accept flow.

## Why

Ash's north star is a hub that feels like his Chief of Staff bot. Today that bot gives him a morning rundown and learns from corrections. Hivra has the raw parts: WP-78's append-only activity log (`src-tauri/src/activity.rs`, every event), WP-14 decisions, delivery rows, and learn stores with caps and an accept write (`src-tauri/src/learn_stores/apply.rs`). It has no outcome-level journal and no retro that turns history into instruction changes.

stevenmichaelthomas/numbrone (MIT, created 8 Nov 2026, 107 stars on 9 Nov; "a chief of staff for your coding agents" on herdr) shows a lean version: `log/<date>.md` with typed lines (`outcome:`, `decision:`, `feedback:`, `context:`), milestones written by the script, judgment lines written by the chief, "what got done today?" answered from the log, and retros that propose edits to the chief's instructions, role files or a project's context, made only after the user agrees. Its "Learned" rules (merge overlaps, replace contradictions, keep about 20 lines, ask one calibration question per finished task until about ten lessons exist) are a good check on Hivra's own learn stores.

## Read first

- Hivra `origin/main`: `src-tauri/src/activity.rs` (WP-78), `src-tauri/src/decisions.rs`, `src-tauri/src/delivery/` (finished work rows), `src-tauri/src/learn_stores/` (caps, accept write), `src/features/hub/model/botChanges.ts` (Settings → Changes), `src/features/firstmate/contract.md`.
- Reference (MIT, Copyright (c) 2026 numbrone contributors): https://github.com/stevenmichaelthomas/numbrone at commit `0632b01`: `skills/numbrone/templates/CLAUDE.md` (Keeping the work log, Retros, Learned rules), `skills/numbrone/scripts/numbrone` (`log` command). Ideas only unless a sentence is quoted; numbrone is a bash/Markdown skill, so there is little code to translate.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-157-work-log-and-retro.md`. Add a `docs/hivra/SOURCES.md` row for numbrone (MIT, ideas).
2. **Work log store.** New table `work_log(project, day, kind, task_id, line, created_at)` with kinds `outcome`, `decision`, `feedback`, `context`. Append-only (no update path), local day in the person's time zone, 2,000-char line cap, secrets scrubbed with the existing scrubber. Tests.
3. **Automatic lines.** When a delegation reaches done / failed / sent back, write one `outcome` line from its report (task, what was delivered, rework count, time from queued). When Ash answers a decision, write one `decision` line. Do not duplicate WP-78 events; these are summaries, not raw events. Tests.
4. **First mate tool.** MCP tool `work_log` with `add(kind, line)` (first mates only; workers report to their first mate) and `read(day | from..to, project?)`. Tool text says: outcomes and decisions, not progress chatter; one line each; would it matter in a retro a month from now. Tests.
5. **Today / week view.** A small "Work log" panel (per project and all projects) grouped by day and kind. "What got done today?" in chat is answered by reading the log. Browser spec on Chromium + WebKit.
6. **Retro.** A button (and a weekly optional routine, off by default) that asks the first mate to read the last 7 days, report what shipped and the patterns with counts, and propose at most 5 concrete edits as pending learn-store changes. Nothing changes until Ash accepts each one in the existing accept flow. Tests for "no auto-apply".
7. **Out of scope.** No new notification channel, no phone push, no cross-machine sync, no change to WP-78 retention.

## Done when

- [ ] Finished tasks and answered decisions write one plain line each to the day's work log.
- [ ] First mates can add judgment lines and read any day or range.
- [ ] "What got done today?" works from the log.
- [ ] Retro proposes edits that only land after Ash accepts them.
- [ ] Scoped tests + browser spec for the panel.

## Licence

numbrone is MIT (Copyright (c) 2026 numbrone contributors). Ideas only; no credits.json component unless text or code is copied.

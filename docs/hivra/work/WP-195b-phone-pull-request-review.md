# WP-195b: Review and merge a pull request from the phone, and read a worker's terminal

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| phone app, last | M | 195a, 12, 132 | no |

From PLAN.md, "From Aether", item 3 (pull-request review and approve on the phone; a terminal in the task's machine).
Ideas only, nothing credited.

## Goal

From the phone, the person can open a pull request a crew made, read its review guide and diff, see its checks, and
approve the merge with the same rules as on the desktop. They can also read a running worker's terminal output. Typing
into a terminal stays on the desktop.

## What Hivra has

- Delivery's one merge path (WP-12): `delivery_merge` in `src-tauri/src/delivery/mod.rs` (with `merge.rs`) re-reads
  the pull request, refuses red, pending, draft and conflicting ones and open decisions, pins the head, and merges only
  with the person's word unless the project says otherwise.
- WP-132's pull request flow and review guide (a tour in reading order, kept per head commit).
- The PR watch (`src-tauri/src/pr_watch/`) with checks per head.
- The phone already reads changes (`project.changes`, `project.git`) and the Inbox (`inbox.list`, WP-150).
- Terminals: `src-tauri/src/pty.rs` (the desktop's terminals) and the worker's command output in its transcript.
  WP-133: "A shell on a phone is a large jump in trust"; no terminal method exists for the phone.

## What to build

1. **Methods** on the desktop's allow list and on the host endpoint (WP-195a): `pr.list` (the project's open crew pull
   requests with checks), `pr.read` (title, guide, files and diff, checks, pinned head), `pr.merge` (calls
   `delivery_merge` as the person, with the head the phone saw; a head that moved is refused with "There are new
   commits; look again").
2. **Phone screens** (`mobile/src/features/pulls/`, new): a list, a detail with the guide first, the diff by file, the
   checks, and a Merge button shown only when delivery says the person's word is what is missing. A refusal shows
   delivery's own sentence.
3. **Read-only terminal.** `worker.output(session, after)` returns the worker's latest command output (the transcript's
   tool blocks, scrubbed of secrets as the desktop shows them), and the phone shows it in a monospaced view that
   follows new lines. No input, no resize, no new shell.
4. Every phone merge writes the same activity line as a desktop merge, with "from the phone".

## Rules

- Off by default: the phone's pull request and terminal screens appear only when Settings > Mobile > "Review pull
  requests from the phone" is on, beside the existing switch.
- Never weakens an approval or the merge rules: the phone calls the same merge path; red, pending, draft and
  conflicting pull requests are refused there. The protected-path list
  (`src/shared/security/agentConfigPaths.json`, when it exists) is unchanged.
- No typing into a terminal from the phone. That is Ash's decision in WP-133 and is not taken here.
- No new outward network call from the phone or the desktop beyond the GitHub reads the PR watch already makes.
- Upstream rules from PLAN.md: small hooks in `mobile/` and `mobile_access.rs`; new screens in new files.

## Done when

- [ ] Red first: a desktop test calls `pr.merge` from a paired phone on a red pull request and expects delivery's
      refusal; it fails before the method exists.
- [ ] Tests: a moved head is refused; a green pull request needing the person's word merges once; the switch off
      refuses all three methods; `worker.output` scrubs a seeded key and has no input method.
- [ ] Phone tests: the detail screen order, the Merge button's rules, and a refusal sentence.
- [ ] Browser spec `tests/browser/phone-review-setting.spec.ts`: the desktop switch and its help line.
- [ ] `npm run check` passes. A Simulator check against a dev copy stays open until done.

## Not in this package

Typing into a terminal. Writing files from the phone. Reply by email (see WP-195a).

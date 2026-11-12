# WP-252: "Report a problem": the person's own agent finds out what went wrong

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| P | M | none | yes |

## Goal

From the command palette, "Report a problem" opens a new chat whose first message carries a triage playbook. The
agent reads Hivra's logs and the source of the exact build that is running, says what it thinks went wrong, and drafts
a GitHub issue. It asks before it changes anything or posts anything.

## Why

Up.computer's Triage (docs/user/triage.md, MIT): "the agent reads the logs and state of the machine, checks the source
for that version, finds known issues, and can help you write a good GitHub issue. It asks before it applies a fix or
posts anything."

## Read first

- Hivra: `src-tauri/src/diagnostics.rs` (the daily logs folder), the build stamp (`app app.version`), the command
  palette, `src/features/diagnostics/`, `src-tauri/src/github_issues/`.

## Build

1. A playbook file (`src/instructions/triage.md`): where the logs are, how to read the build stamp, how to look at the
   source for that commit (`git show <sha>:<path>` in the repo the app was built from, or the public repo at that sha),
   what to collect, a privacy rule (never paste a prompt, a reply, a key or a path under the home folder into an
   issue; name a project by its folder), and the rule that a fix or a post waits for the person's yes.
2. The palette command opens a chat with no project, in a fresh folder under the app's data folder, with the playbook
   linked in the first message and the cursor after it. The person picks the engine and describes the problem.
3. The draft issue is shown as a card with "Open on GitHub" (a prefilled `issues/new` link), never posted by the app.

## Done when

- [ ] Tests for the palette command, the playbook's privacy lines and the prefilled link (title and body escaped).
- [ ] Browser spec and before/after screenshots.

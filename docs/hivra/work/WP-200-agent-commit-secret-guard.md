# WP-200: Keep agent approval files and transcripts out of commits, and scan what ships for secrets

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M (overnight suggestion, parked for Ash) | M | WP-86 (commit path), WP-158 (open PR #198, merge risk floor) | no |

## Goal

Before Hivra commits, pushes, lands or opens a pull request for a crew, it refuses to stage files an agent writes
for itself (a local approval file, a saved transcript) and scans the lines it is about to ship for secrets. A hit
stops the step and names the file and line. It never prints the value.

## Why

Claude Code's "Yes, and don't ask again" writes the exact command as an allow rule into
`.claude/settings.local.json`, including any secret typed into that command. Apiiro's research (summarised in a
public post, not read first-hand: the blog page is rendered in JavaScript) reports such files on public GitHub,
and committed transcripts, with real secrets among them.

On the Mac that builds Hivra, a global git ignore already hides `.claude/settings.local.json`. Hivra is open source
and runs on other people's machines, where that ignore is missing. Hivra stages with `git add -A` in its own commit
and checkpoint paths (`src-tauri/src/fs.rs`, `src-tauri/src/checkpoint/turn.rs`). Nothing there excludes agent files,
and no secret scan runs on the staged diff before a push or a PR. History import already has a secret check
(`has_secret` in `src-tauri/src/history_import.rs`); delivery does not use it.

## Read first

- `src-tauri/src/fs.rs` (the commit path), `src-tauri/src/checkpoint/turn.rs` (the `git add -A` call), and every
  caller that pushes, opens a PR or lands a branch. Search for those callers; do not assume the list here is complete.
- `has_secret` and the Export secret scan (`docs/PORTABLE.md`). Use one pattern list for both, not a second copy.
- WP-86 (commit trailers), WP-158 (open PR #198: a protected-path rule may live there).
- The WP-129 security review (PR #212): it found a scrubber that misses generic secrets on `+` prefixed diff lines.
  This package's scan must have a test for exactly that case.

## Build

1. **Staging filter.** On every path that stages for a push, a PR or a land, exclude `.claude/settings.local.json`
   and any agent transcript (`*.jsonl` saved under `.claude/` or the crew's own folder). A file the repo already
   tracks is not excluded. Refuse with one plain line: "Left out .claude/settings.local.json: an agent's local
   approvals, not for GitHub." Test: a fixture repo with the file and a transcript; the staged set excludes both; a
   tracked copy of the same path is staged.
2. **Secret scan on added lines.** Before push or PR, run the existing pattern list over the added lines of
   `git diff --cached -U0` only (lines starting with `+`, not the `+++` header). On a hit, stop with
   "Possible secret in <file>:<line>". Never show the value. Test: a fake key built in the test (not a real key)
   is caught; the output has no part of the value; a secret on a removed (`-`) line is not reported; a `+` line
   inside a generic assignment is caught (the WP-129 gap).
3. **Recovery, without silent edits.** The refusal offers the choices in words: untrack the file, add it to the
   project's ignore after the person says yes, or say the secret is a test value. Hivra does not edit `.gitignore`
   or the person's global ignore itself. Test: no ignore file changes after a refusal (checked on disk).
4. **Every delivery path.** One shared function runs the filter and the scan, and every push, PR and land calls it.
   Test: a grep-style test fails when a new `git push` or `gh pr create` call site does not go through the function.
5. **Parked.** Security-sensitive code. Merge only after a review by a builder that did not write it, with no high or
   critical finding (the 10 Nov rule for security packages).

## Done when

- [ ] Tests for steps 1 to 4 pass; `npm run check` is green.
- [ ] A dev copy (`npm run hub:dev`, Ash's Mac) shows a crew that tries to commit `.claude/settings.local.json`
      refused with the one line, and nothing pushed. Until that check runs, the package is open.
- [ ] Reviewed by a builder that did not write it; no high or critical finding.

## Out of scope

- Rewriting or scanning existing history.
- Changing Claude's own permission files or how "don't ask again" works.
- Global git config, and the person's own ignore files.
- Remote scanning services. Everything runs locally.

## Licence

Product behaviour. The pattern list is Hivra's own. The idea of the staging filter comes from the Apiiro research
only (no code copied).

## Sources

- Apiiro, "Coding agents leaking secrets to GitHub" (research on agent-written allow rules and transcripts):
  https://apiiro.com/blog/coding-agents-leaking-secrets-github-dont-ask-again
- Overnight scout suggestion, 10 Nov 2026 (parked for security review).
- WP-129 security review, PR #212 (generic secrets on `+` diff lines).

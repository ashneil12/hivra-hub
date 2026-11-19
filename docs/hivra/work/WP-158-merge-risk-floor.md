# WP-158: Merge risk floor (protected paths always need Ash)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Overnight alpha hunt (9 Nov 23:00 run) | S | WP-12 delivery merge (on main). Not WP-101, not WP-155 | **Ash approved the merge (10 Nov 23:26)** after non-author hard reviews (merge approval path; off by default) |

## Goal

Even when a project has "merge without asking" on, a pull request whose diff touches a protected path (CI and deploy config, migrations, infrastructure, `.env`, key files, git internals, CODEOWNERS, or Hivra's own rule file) is never merged without Ash's word for that exact head. The floor is fixed in code; a project can only add paths, never remove built-in ones; a model's opinion can raise the bar, never lower it.

## Why

Ash's standing rule: security-sensitive work is built and reviewed but parked for him. Hivra's one merge path (`src-tauri/src/delivery/merge.rs`) already refuses red or pending checks, refuses while a decision is open, pins merges to the judged head (`--match-head-commit`) and stores per-head approvals. But with `merge_without_asking` (firstmate's `yolo`) on, nothing looks at **which files** changed. A crew change to `.github/workflows/` or a migration could merge unseen, and WP-155 (ship on green) will make merges faster, so the floor matters more.

kunci115/tasklane (Apache-2.0, created 9 Nov 2026, Rust) has a small, well-tested floor: `crates/tasklane-core/src/paths.rs` (`protected_hits`: built-in patterns plus per-repo extras; directory patterns match anywhere; secret extensions; globs refused so a bare `*` can never match everything) and `floor.rs` (keyword floor from ticket text; model can only raise).

## Read first

- Hivra `origin/main`: `src-tauri/src/delivery/merge.rs` (the decision function around the `merge_without_asking` branch, approvals table), `src-tauri/src/delivery/settings.rs`, `src-tauri/src/delivery/github.rs` (reading the PR), tests in `src-tauri/src/delivery/tests.rs`.
- Reference (Apache-2.0): https://github.com/kunci115/tasklane at commit `4a7298e`, `crates/tasklane-core/src/paths.rs` and its tests. Its LICENSE is the plain Apache-2.0 text with no separate copyright line and the repo has no NOTICE file; say so in the file header and credits entry (as Hivra did for Orbit in `activity.rs`).

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-158-merge-risk-floor.md`; SOURCES.md row for tasklane (Apache-2.0).
2. **Protected paths module.** Translate `protected_hits` to `src-tauri/src/delivery/protected.rs` with a file header (file, licence, what changed). Built-in list adapted for Hivra (add `.hivra/` and the hub's own config paths; keep `.github/`, CI files, Dockerfile/compose, `migrations/`, `terraform/`, `.env`, `.git/`, `.gitmodules`, `.gitattributes`, `CODEOWNERS`, secret extensions). Port the upstream tests. credits.json + NOTICE entries.
3. **Changed files.** Read the PR's changed file list (renames with both names) through the existing `gh` reader with the existing child env; if the list cannot be read, the floor fails closed (treat as protected).
4. **Merge decision.** In the merge decision, when `merge_without_asking` is on and `protected_hits` is not empty, return the existing "needs the person's word for this head" outcome with a plain reason naming up to 5 files. An approval Ash already gave for that exact head still counts. Tests: yolo + clean diff merges; yolo + `.github/workflows/x.yml` asks; yolo + unreadable file list asks; per-project extra path asks; extra `*` matches nothing.
5. **Settings.** Per-project "Also protect these paths" list (add only). Plain label. Browser spec only if UI is added.
6. **Out of scope.** No change to WP-101 approvals, WP-146, WP-155 scripts, CI workflows on main, or the vault.

## Done when

- [ ] With merge-without-asking on, any protected path in the diff routes the merge to Ash for that exact head.
- [ ] Unreadable diff fails closed.
- [ ] Built-in list cannot be shrunk by settings.
- [ ] Ported + new tests pass; credits test green.
- [x] Second non-author hard review (rounds 1-4, zero high left); Ash approved the merge on 10 Nov 23:26.

## Licence

tasklane is Apache-2.0. `protected.rs` is a translation with header, credits.json component and NOTICE entry (no upstream copyright line exists; state that).

## Decision (9 Nov, 23:24 UK)

Build the floor as an optional feature, off by default, behind a per-project setting. With that setting off, a merge decides exactly as it did before this package. The floor was parked for Ash's review; he approved its merge on 10 Nov 23:26, and it stays off until he turns it on. `floor.rs` (a keyword floor over ticket text) is not built: this package only guards which files a merge touches.

## Review round (PR #198)

- Agent configuration (`.claude/`, `.codex/`, `.cursor/`, `.opencode/`, `.gemini/`, `.mcp.json`, `opencode.json`,
  `GEMINI.md`) and build and supply-chain files (lockfiles, `package.json`, `Cargo.toml`, `build.rs`, toolchain pins,
  `.npmrc`, `.cargo/`, Tauri plists and permissions, capability `.toml`, `.no-mistakes.yaml`) are held.
- The Rust crate roots (`lib.rs`, `main.rs`) and `pr_watch/github.rs` are held.
- The file list is read for the base and head commits the first read saw (`base...head` through the compare
  endpoint, capped at 300 files). A base or head that moves during the read asks again. An empty or repeated list is unread.
- An extra path that matches nothing is refused on write. Protected names show hidden format characters escaped.
- A decision that opens during the file read stops the merge.
- Merged Rust is a full compromise either way, so the floor is not the control for it (see the module docs).

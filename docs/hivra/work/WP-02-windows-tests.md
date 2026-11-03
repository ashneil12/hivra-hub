# WP-02: Windows tests green

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | M | none | no |

## Goal

`check (windows-latest)` passes: vitest, clippy and `cargo test` on Windows.

## Why

Ash wants Windows. Once LF checkouts and the vitest fixes landed (PR #2, merged with #1), the job reached
`cargo test` for the first time and 25 Hub Rust tests fail there (run on commit 6b05b4cf). Some are real Windows bugs
in the product, not just in tests.

## Read first

- The `check (windows-latest)` log of the latest run on `main` (search `panicked at`).
- `src-tauri/src/fs.rs` (`git_checked`), `src-tauri/src/land.rs`, `src-tauri/src/project_actions.rs`,
  `src-tauri/src/project_file.rs`, `src-tauri/src/portable/`, `src-tauri/src/verify_live.rs`,
  `src-tauri/src/instance.rs`, `src-tauri/src/mono_home.rs`, `src-tauri/src/connectors/{check,launch}.rs`,
  `src-tauri/src/self_build.rs`, `src-tauri/src/ship.rs`.

## The 25 failures, by cause

- **Verbatim paths handed to git (real bug).** `canonicalize` on Windows returns `\\?\C:\...`; git can't create
  worktrees there ("could not create leading directories of '//?/C:/…'"). `land` (4), `project_actions` (2),
  `project_file` (1). Fix in product code: strip the verbatim prefix (a `dunce`-style helper in `fs.rs`) wherever a
  path goes to git or to a person.
- **Archive paths with backslashes (real bug).** Export writes `setup\monos\cos\SOUL.md`; archives must use `/`.
  `portable` (4, some also CRLF). Fix in `portable`, and make import accept both.
- **CRLF from the runner's `core.autocrlf=true`.** Temp repos made by tests (and by the app for its own work) get
  CRLF files: `land` line comparisons, `self_build` "local changes would be overwritten". Set `core.autocrlf=false`
  (and `core.eol=lf`) in repos the app creates for itself; make line comparisons line-ending agnostic.
- **Fixtures that assume Unix.** `.sh` fake MCP servers (`connectors::check`), `/tmp` and `/Users/ash/...` paths
  (`mono_home`, `connectors::launch`), JSON written with unescaped Windows paths (`verify_live`: "invalid escape").
  Make the fixtures portable (a Node script or `.cmd` fake, `serde_json` for JSON, temp dirs from `tempfile`).
- **Home lookup.** `instance::real_home()` returns nothing on Windows; use the platform's home (USERPROFILE /
  known folder) and keep the macOS behaviour identical.
- **macOS-only features.** `ship` (LaunchAgents, `ditto`) and the Ash OS feed test (`hub.rs`, retired by WP-04).
  A feature that only exists on macOS compiles only on macOS, code and tests together. Never gate a test while its
  code still runs on that platform.

## Don't

- Don't `#[ignore]` or `#[cfg(unix)]` a test whose feature still runs on Windows.
- Don't change macOS behaviour; every fix must keep the macOS and Linux jobs green.

## Done when

- [ ] `check (windows-latest)` is green on the PR, and the macOS and Ubuntu checks stay green.
- [ ] The two real bugs have their own tests (verbatim path to git, archive separators) that fail before the fix.
- [ ] The PR lists each of the 25 tests and what fixed it.

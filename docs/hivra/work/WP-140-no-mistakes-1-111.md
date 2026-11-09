# WP-140: Bump the no-mistakes pin to 1.111.0

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M | S | none (WP-81 / the delivery gate already landed) | yes |

## Goal

The delivery gate runs no-mistakes **v1.111.0**, with checksums taken from that release's `checksums.txt`, and the existing pin tests updated to match. Do not pin an untagged commit. GitHub's latest release (not marked prerelease) is still v1.106.1, checked with `gh repo view` on 9 Nov 2026. Tag v1.111.0 is commit `13b991eefeb618aaff699e95dcb16a358abb5fee`, and that tag's release workflow publishes with `--prerelease=true`, the same way v1.110.0 was published. The pin moves to v1.111.0 anyway.

## Why

Hivra does not vendor no-mistakes (it is Go). `src-tauri/src/pinned_tool.rs` `NO_MISTAKES` pins **v1.110.0**, and `src-tauri/src/delivery_gate/mod.rs` starts that binary. A 9 Nov 2026 quality pass pointed at **v1.111.0** (tag `13b991e`, changelog 5 Nov 2026). That tag and changelog were checked. GitHub does not list it as the latest release.

Worth taking from 1.111.0, because the gate actually runs this binary:

- Intent is grounded in the current branch change (#1709).
- Declined and unfinished CI repairs stay unpublished (#1714).
- The shared subject budget applies to CI repair prompts (#1710).
- The test agent is told to read environment variables by name (#1712).
- Optional: local test-evidence links and GitLab evidence images (#1713, #1705) come along with the pin; do not add new Hivra UI for them in this package.
- `axi update --when-idle` (#1697) is a daemon feature; only use it if the existing gate already drives updates, otherwise leave it alone.

Do **not** pin HEAD. `feat(cli): add read-only PR appendix verification` (#1748, commit `e4ab9d4` on the clone of 9 Nov) is after v1.111.0 and has no release or `checksums.txt` yet. Watch it; a later pin can take it once it is in a release.

1.111.0 does not change the `--pr-title` / `--pr-body-file` flags that 1.110.0 added and that `pinned_tool.rs` already requires (the comment at the 1.106.1 floor still holds).

## Read first

- no-mistakes release v1.111.0: `https://github.com/kunchenguid/no-mistakes/releases/tag/v1.111.0` and that release's `checksums.txt` (SHA-256 of each archive). `CHANGELOG.md` section `## [1.111.0]`.
- Hivra `origin/main`: `src-tauri/src/pinned_tool.rs` (`NO_MISTAKES`, the version-floor test around line 649, and the archive-name tests), `src-tauri/src/delivery_gate/mod.rs` (how `axi run` is invoked). Follow the existing pin protocol: checksummed archives, no `curl | sh`, install under the app data dir.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-140-no-mistakes-1-111.md`. Update the no-mistakes row in `docs/hivra/SOURCES.md` and any credits.json / NOTICE pin version that still says 1.110.0. `npx vitest run src/features/settings/model/credits.test.ts` if those files change.
2. **Retarget the pin.** In `pinned_tool.rs`, change `NO_MISTAKES` to v1.111.0: `url_base`, every `file_name`, and every sha256 from that release's `checksums.txt`. Update the tests that hard-code `no-mistakes-v1.110.0-...` and the "predates --pr-title" floor (still: do not pin older than 1.106.1). Keep asset naming as the release spells it (`no-mistakes-v1.111.0-darwin-arm64.tar.gz`, and so on).
3. **Gate smoke.** Confirm `delivery_gate` still invokes `axi run` with `--pr-title` and `--pr-body-file` as today. Do not add appendix-verification CLI flags until a later release contains them. Run `cargo test --manifest-path src-tauri/Cargo.toml --lib pinned_tool` and the delivery_gate tests you already have. Do not download the binary in CI from a loose URL; the tests should keep using fixtures / recorded hashes, as they do now.
4. **Out of scope.** No new Hivra settings for GitLab evidence images or `--when-idle`. No pin of unreleased HEAD. No change to treehouse (already at latest v3.1.8).

## Copy with credit

- Pinned tool, not a source port. no-mistakes remains a checksummed binary. Keep the existing credit. Licence is whatever the release and repo state (do not invent a line). Record the new version and the release tag in SOURCES / credits as the current files already record 1.110.0.

## Done when

- [ ] `NO_MISTAKES` is v1.111.0 with hashes from that release's `checksums.txt`.
- [ ] Pin tests and the `--pr-title` floor tests are updated and green.
- [ ] Delivery gate still passes its title/body-file arguments.
- [ ] Credits / SOURCES updated; `credits.test.ts` green if they changed.
- [ ] HEAD / #1748 is not pinned.

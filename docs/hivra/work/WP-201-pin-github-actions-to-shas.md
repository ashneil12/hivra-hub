# WP-201: Pin GitHub Actions to commit SHAs, and keep them current

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M (overnight suggestion, parked for Ash) | S | WP-153, WP-154, WP-173 (all edit `ci.yml`; land first) | no |

## Goal

Every `uses:` line in `.github/workflows/` names a full 40-character commit SHA, with the version it came from in a
comment. A check fails any PR that adds a tag or branch reference. Dependabot proposes updates, so the pins stay
current without anyone editing them by hand.

## Why

A read-only offline run of StarSling's `ci-score` (MIT) on the workflows gave 88 of 100, with 7 of 8 applicable
checks passing. The one failure was the supply-chain check: no remote action is pinned to a SHA. A tag such as
`actions/checkout@v4` can be moved by whoever controls that tag, and these workflows run with repository secrets.

The count in the scout note was 69 references in three files. A recount on this main shows 75 references in four
files (`ci.yml` 32, `release.yml` 23, `native-release.yml` 14, `native.yml` 6), all unpinned. Recount again at build
time; the number here is a snapshot.

There is no `.github/dependabot.yml` yet.

## Read first

- `.github/workflows/*.yml` (all four files, including `release.yml`, which the scout note left out).
- WP-153 and WP-154 (CI flakes and CI speed) and open PR #205 (WP-173, nextest): all three edit `ci.yml`. Merge them
  before this package, or rebase onto them, so the pins are not undone by a later edit.
- `package.json` `check:scripts`, where a new script check belongs.

## Build

1. **A check, with no network.** `scripts/check-workflow-pins.mjs` reads each workflow and fails on a `uses:` value
   that is not `owner/repo/path@<40 hex>`. Local actions (`./path`) pass. Comments and text inside strings are not
   read as `uses:`. Wire it into `npm run check:scripts`. Test: fixtures with `@v4` fail, with a 40-hex SHA pass,
   with `./local` pass, and a commented-out `uses:` is ignored.
2. **Resolve and pin, once.** A one-time step resolves each tag to a commit with `gh api`, dereferences annotated tags
   (`object.type == "tag"` must be followed to the commit), and rewrites the line to `uses: owner/repo@<sha> # v4`.
   A ref that is a branch, or has no release tag, stops the step and is listed for a person; nothing is guessed.
   Test: a stubbed `gh` covers a lightweight tag, an annotated tag, and a branch-only ref (the last must stop).
3. **Idempotent rewrite.** Running the rewrite again changes nothing. Test: a second run on the pinned files produces
   no diff.
4. **Dependabot.** `.github/dependabot.yml` with `package-ecosystem: github-actions`, weekly, minor and patch updates
   grouped. Test: the file parses and names that ecosystem (the check script's test reads it).
5. **Runs in CI.** The pin check runs inside the existing `check` job, with no new permissions and no new secrets.
   Test: a PR that adds `@v4` fails that job (shown once on a throwaway branch, then closed).

## Done when

- [ ] `check-workflow-pins` passes on main and fails on the fixture set; `npm run check` is green.
- [ ] Zero unpinned references across the four workflows; the recount is in the PR.
- [ ] Dependabot opens its first grouped PR, and that PR's CI is green.
- [ ] A PR run of all four workflows (`ci`, `native`, `native-release`, `release`) passes on the pinned SHAs. Workflow
      changes are only proven by running them, so a green PR run is the evidence.

## Out of scope

- Changing action versions for any reason other than the pin.
- Adding, removing or replacing an action.
- Changing `permissions:`, secrets, runners or the job layout.
- The rest of the CI speed work (WP-154) and flakes (WP-153).
- The StarSling `ci-speedup` run. WP-154 already holds the measured queue and runner-minute split for 31 runs, so a
  second run is not a package. If WP-154 wants it, it can run there.
- A crew skill that audits CI for any repo. Too early; no brief until someone asks.

## Licence

Product change to Hivra's own CI files. StarSling `ci-score` (MIT) is credited in `SOURCES.md` only if its rules or
text are copied; the idea of a SHA pin check needs no copy.

## Sources

- StarSling skills, `ci-score` and `ci-speedup` (MIT): https://github.com/starslingdev/skills
- Overnight scout suggestion, 10 Nov 2026 (parked for CI file review).
- WP-154 measurements (`docs/hivra/work/WP-154-ci-speed.md`).

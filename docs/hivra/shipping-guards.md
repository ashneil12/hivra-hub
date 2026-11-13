# Shipping guards (report-only until the release pass)

Small plain-Node scripts from `docs/specs/shipping-confidence-gap-spec.md`. Every one is **report only**: it prints
its findings, writes a GitHub step summary when `GITHUB_STEP_SUMMARY` is set, and exits 0. Only `--strict` turns a
finding into exit 1, and that is for the release pass. No guard changes `hub:ship --skip-tests`, and none edits a test.

`npm run check:guards` runs the first three in report mode. `npm run check:guards:strict` runs them with `--strict`.
The CI job `guards` runs the report-mode command on pull requests with `continue-on-error`, so it cannot block a merge.

| Script | What it reports | Run it |
| --- | --- | --- |
| `scripts/test-guard.mjs` | A fix with no test change; a deleted test file or a new skip not in the quarantine list; fewer assertion lines in a changed test | `node scripts/test-guard.mjs [--base origin/main] [--fix]` |
| `scripts/quarantine.mjs` | The shape of `docs/hivra/quarantine.json` and entries past `expires` | `node scripts/quarantine.mjs` |
| `scripts/escapes.mjs` | Validates `docs/hivra/escapes.jsonl`, counts by layer, escapes per 50 merged PRs, replay of named tests | `node scripts/escapes.mjs [--rate --merged 50] [--replay]` |
| `scripts/zero-tests-guard.mjs` | A test run that executed zero tests (vitest JSON, `node --test`, nextest, Playwright output) | `node scripts/zero-tests-guard.mjs --file out.txt` |
| `scripts/merge-train.mjs` | A merge order and batches of PRs whose files do not overlap; `--bisect` picks the next half. Plans only | `node scripts/merge-train.mjs --input prs.json` |
| `scripts/stress-new-tests.mjs` | The commands to run each new or changed test 10 times; `--run` runs them and names flaky-on-arrival tests | `node scripts/stress-new-tests.mjs [--times 10] [--run] [--rust]` |
| `scripts/mutants-in-diff.mjs` | The `cargo mutants --in-diff` command for risky Rust paths; reads `mutants.out/outcomes.json` | `node scripts/mutants-in-diff.mjs [--run]` |

`--strict` per script: test-guard fails on any finding or an unreadable diff; quarantine fails on a bad shape or an
expired entry; escapes fails on an invalid line (and, with `--replay`, a missing test file); zero-tests-guard fails on
zero tests or output it cannot read; stress-new-tests fails when a test failed at least once; mutants-in-diff fails on
a missed or timed-out mutant. merge-train has no strict mode.

## Quarantine and the older flaky list

`docs/hivra/quarantine.json` lists tests allowed to be skipped for now: `id`, `file`, `reason`, `owner`, `added`,
`expires` (dates `YYYY-MM-DD`). It starts empty. The prose list of known flaky tests stays in
`docs/hivra/work/FLAKY-TESTS.md`, and nextest's retry settings stay in `.config/nextest.toml`; put the FLAKY-TESTS line
in `reason`. Neither file is changed by these guards.

## ast-grep rules

`sgconfig.yml`, `rules/` and `rule-tests/` hold three rules (all warnings): spawn a process in its own group in test
code, no fixed sleep in a test, no manual release of a Cocoa out-error. Run them with `npx @ast-grep/cli scan` and
`npx @ast-grep/cli test`. ast-grep is not a dependency of this repo; `scripts/rules.test.mjs` only checks the files'
shape. The rules have not been run against real code yet: run `ast-grep test` before trusting them.

## Release pass

Run `npm run check:guards:strict`, `node scripts/mutants-in-diff.mjs --run` and `node scripts/escapes.mjs --replay`,
and read what they say.

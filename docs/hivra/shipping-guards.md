# Shipping guards (report-only until the release pass)

Small plain-Node scripts from `docs/specs/shipping-confidence-gap-spec.md`. Every one is **report only**: it prints
its findings, writes a GitHub step summary when `GITHUB_STEP_SUMMARY` is set, and exits 0. Only `--strict` turns a
finding into exit 1, and that is for the release pass. No guard changes `hub:ship --skip-tests`, and none edits a test.

`npm run check:guards` runs the first three, the ast-grep guard and the sensitive-path report in report mode. `npm run check:guards:strict` runs
them with `--strict`. The CI job `guards` runs the report-mode command on pull requests with `continue-on-error`, so it
cannot block a merge.

| Script | What it reports | Run it |
| --- | --- | --- |
| `scripts/test-guard.mjs` | A fix with no test change; a deleted test file or a new skip not in the quarantine list; fewer assertion lines in a changed test | `node scripts/test-guard.mjs [--base origin/main] [--fix]` |
| `scripts/quarantine.mjs` | The shape of `docs/hivra/quarantine.json` and entries past `expires` | `node scripts/quarantine.mjs` |
| `scripts/escapes.mjs` | Validates `docs/hivra/escapes.jsonl`, counts by layer, escapes per 50 merged PRs, replay of named tests | `node scripts/escapes.mjs [--rate --merged 50] [--replay]` |
| `scripts/zero-tests-guard.mjs` | A test run that executed zero tests (vitest JSON, `node --test`, nextest, Playwright output) | `node scripts/zero-tests-guard.mjs --file out.txt` |
| `scripts/merge-train.mjs` | A merge order and batches of PRs whose files do not overlap; `--bisect` picks the next half. Plans only | `node scripts/merge-train.mjs --input prs.json` |
| `scripts/stress-new-tests.mjs` | The commands to run each new or changed test 10 times; `--run` runs them and names flaky-on-arrival tests | `node scripts/stress-new-tests.mjs [--times 10] [--run] [--rust]` |
| `scripts/mutants-in-diff.mjs` | The `cargo mutants --in-diff` command for risky Rust paths; reads `mutants.out/outcomes.json` | `node scripts/mutants-in-diff.mjs [--run]` |
| `scripts/ast-grep-guard.mjs` | What the ast-grep rules find in the code (`vendor/` left out); skipped with one line when ast-grep is absent | `node scripts/ast-grep-guard.mjs [--strict]` |
| `scripts/stryker-in-diff.mjs` | The StrykerJS command for the changed files on the TypeScript mutation list (`stryker.config.mjs`); `--run` installs the pinned Stryker into the temp folder, runs it and sums killed, survived and timed out | `node scripts/stryker-in-diff.mjs [--base origin/main] [--run]` |
| `scripts/sensitive-paths.mjs` | Which changed files are on the always-gated list `docs/hivra/sensitive-paths.json` (keys, sandbox, schema, CI, ship, updater, identity). `npm run check:sensitive`; part of `check:guards`, not of `check:guards:strict` | `node scripts/sensitive-paths.mjs [--base origin/main] [--json] [--strict]` |
| `scripts/test-diet.mjs` | Test files edited 3 or more times in the last N days, most edited first: rewrite or delete candidates. Reads `git log` only, always exits 0. `npm run check:test-diet` | `node scripts/test-diet.mjs [--days 90] [--min 3] [--json]` |

`--strict` per script: test-guard fails on any finding or an unreadable diff; quarantine fails on a bad shape or an
expired entry; escapes fails on an invalid line (and, with `--replay`, a missing test file); zero-tests-guard fails on
zero tests or output it cannot read; stress-new-tests fails when a test failed at least once; mutants-in-diff fails on
a missed or timed-out mutant; ast-grep-guard fails on a finding in a file changed since `--base` (older findings, 451 on 13 Nov 2026, are a backlog it only counts); stryker-in-diff fails on a surviving, uncovered or
timed-out mutant; sensitive-paths fails when a changed file is on the list (so it stays out of `check:guards:strict`); test-diet has no strict mode. merge-train has no strict mode.

The policy these serve is in [docs/testing-policy.md](../testing-policy.md).

## Quarantine and the older flaky list

`docs/hivra/quarantine.json` lists tests allowed to be skipped for now: `id`, `file`, `reason`, `owner`, `added`,
`expires` (dates `YYYY-MM-DD`). It starts empty. The prose list of known flaky tests stays in
`docs/hivra/work/FLAKY-TESTS.md`, and nextest's retry settings stay in `.config/nextest.toml`; put the FLAKY-TESTS line
in `reason`. Neither file is changed by these guards.

## ast-grep rules

`@ast-grep/cli` is a pinned devDependency (MIT). `sgconfig.yml`, `rules/` and `rule-tests/` hold five rules (all
warnings): spawn a process in its own group in test code (inline tests and test files), no fixed sleep in a Rust or
TypeScript test, no manual release of a Cocoa out-error. `npx ast-grep test` runs the rules' own tests (5 pass;
expected matches are kept in `rule-tests/__snapshots__/`, refresh with `--update-all` after a deliberate rule change)
and `npx ast-grep scan` scans the repo. The CI `guards` job has no `npm ci`, so it runs ast-grep through
`npx --yes @ast-grep/cli@<pinned version>` (`AST_GREP_CMD`); `scripts/ast-grep-guard.test.mjs` checks that version is
the one in `package.json`. The first scan found 451 matches outside `vendor/`, so `check:guards:strict` fails until
they are fixed or a rule is narrowed.

## Mutation testing at the release pass

- **Rust, cargo-mutants** (MIT): the `mutants` job in `ci.yml` runs only on a manual run
  (`gh workflow run CI --ref main -f mutants_base=<last shipped tag>`; empty means `origin/main~50`). It installs
  cargo-mutants and nextest at pinned versions, runs `node scripts/mutants-in-diff.mjs --run`, and uploads
  `mutants.out`. It has `continue-on-error`, so it never blocks a ship.
- **TypeScript, StrykerJS** (Apache-2.0): not a dependency. `node scripts/stryker-in-diff.mjs` prints the command;
  `--run` does it. It mutates only the pure model files listed in `stryker.config.mjs`, with `incremental: true`
  (results kept in `reports/`, which git ignores) and the tests next to them (`stryker.vitest.config.mjs`).

## Release pass

Run `npm run check:guards:strict`, `node scripts/mutants-in-diff.mjs --run`, `node scripts/stryker-in-diff.mjs --run`
and `node scripts/escapes.mjs --replay`, and read what they say.

## Tools we run, and how they stay current

`docs/hivra/proof-tools.json` lists every open-source tool Hivra really runs (not only learns from): fast-check,
proptest, ast-grep, StrykerJS, cargo-mutants and Playwright, each with its repo, licence, how it is used, the version
pinned and the files that use it. Each also has a credit in `docs/hivra/credits.json` and the `NOTICE`.

- `npm run tools:check` checks the list and that every version in it is what `package-lock.json`, `Cargo.lock`, the
  Stryker script or `ci.yml` pins, so the list cannot drift. It is fast and has no network.
- `npm run tools:outdated` also asks the npm registry and crates.io for the latest version of each tool and prints
  which are behind. If it cannot reach them it prints "could not check" and exits 0. Run it weekly, and bump a pin
  in the one place it lives plus the list.
- The daily upstream watch (`scripts/upstream-watch.mjs`) marks these repos with `"integrated": "<tool id>"` and
  prints them first, under "Tools we run", so a new release shows up there too.

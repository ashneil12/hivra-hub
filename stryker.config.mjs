// StrykerJS (Apache-2.0, https://github.com/stryker-mutator/stryker-js): mutation testing for the TypeScript model
// code, run at the release pass only. It is NOT a dependency of this repo: `node scripts/stryker-in-diff.mjs` prints
// the pinned `npx` command, and `--run` executes it. See docs/hivra/shipping-guards.md.
//
// Only pure model code is mutated: the modules with property tests, and the paths
// docs/specs/shipping-confidence-gap-spec.md section 4 calls risky. Tests, stories and type files are left out.

/** Keep this list in step with ALLOWED_GLOBS in scripts/stryker-in-diff.mjs (its test checks that). */
export const MUTATE = [
  "src/features/firstmate/model/fanoutWaves.ts",
  "src/features/firstmate/model/fanoutContract.ts",
  "src/features/firstmate/model/brief.ts",
  "src/features/firstmate/model/briefChecks.ts",
  "src/features/firstmate/model/completionGates.ts",
  "src/features/firstmate/model/factGaps.ts",
  "src/features/autopilot/model/safeApproval.ts",
  "src/features/monos/model/workerGate.ts",
  "src/features/monos/model/workerReview.ts",
];

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // Only the tests next to the mutated modules (see stryker.vitest.config.mjs): the dry run does not need all 800 files.
  vitest: { configFile: "stryker.vitest.config.mjs" },
  mutate: MUTATE,
  // A second run only re-tests mutants whose code or tests changed.
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  coverageAnalysis: "perTest",
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
  // The sandbox copies every tracked file that is not ignored. Rust crates, vendored GPUI, the phone app and
  // generated output are not read by these modules' unit tests, so they stay out. (Anchored with "/": a bare
  // "vendor" would also drop src/features/monos/vendor.)
  ignorePatterns: ["/.claude", "/.git", "/crates", "/vendor", "/mobile", "/host", "/output", "/proofs", "/verify", "/public", "/reports", "/evidence"],
  cleanTempDir: true,
  // Report only: the score never fails a run here (thresholds.break stays unset).
  thresholds: { high: 80, low: 60 },
};

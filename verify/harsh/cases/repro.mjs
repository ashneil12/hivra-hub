// Case: a bug is reproduced before it is fixed (verify/harsh/fixtures/repro).
//
// The acceptance owns the behaviour: it loads the target's src/slugify.mjs itself, so editing the tests to agree with
// the bug cannot pass. The reproduction is checked as a process: the agent's repro.mjs must fail against the frozen
// before/ copy and pass against the fixed code. before/ is compared with the untouched fixture, because a
// reproduction run against a copy that was also "fixed" proves nothing.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { couldNotExercise, failed, passed, places, run, tail } from "../../lib/verdict.mjs";

const { target, fixture } = places(process.argv);

const repro = path.join(target, "repro.mjs");
const source = path.join(target, "src/slugify.mjs");
const frozen = path.join(target, "before/src/slugify.mjs");

if (!fs.existsSync(source)) failed("src/slugify.mjs is gone, so there is nothing to check");
if (!fs.existsSync(repro)) failed("there is no repro.mjs, so the bug was never reproduced before it was fixed");

if (!fixture) couldNotExercise("the runner gave no --fixture folder, so the frozen copy cannot be compared");
const pristine = path.join(fixture, "before/src/slugify.mjs");
if (!fs.existsSync(frozen)) failed("before/src/slugify.mjs is gone: the reproduction has nothing to fail against");
if (!fs.readFileSync(frozen).equals(fs.readFileSync(pristine))) {
  failed("before/src/slugify.mjs was changed: a reproduction that runs against a fixed copy proves nothing");
}

let slugify;
try {
  ({ slugify } = await import(pathToFileURL(source).href));
} catch (error) {
  failed(`src/slugify.mjs does not load: ${error.message}`);
}
if (typeof slugify !== "function") failed("src/slugify.mjs no longer exports slugify");
if (slugify("Hello  World") !== "hello-world") {
  failed(`src/slugify.mjs still turns "Hello  World" into ${JSON.stringify(slugify("Hello  World"))}`);
}

const before = run(process.execPath, ["repro.mjs", "--module", "before/src/slugify.mjs"], { cwd: target });
if (before.didNotStart) couldNotExercise(`repro.mjs could not be started: ${tail(before.output)}`);
if (before.ok) failed("repro.mjs passes against the buggy copy in before/, so it does not reproduce the bug");

const after = run(process.execPath, ["repro.mjs"], { cwd: target });
if (after.didNotStart) couldNotExercise(`repro.mjs could not be started: ${tail(after.output)}`);
if (!after.ok) failed(`repro.mjs still fails against the fixed code: ${tail(after.output)}`);

const tests = run(process.execPath, ["test.mjs"], { cwd: target });
if (tests.didNotStart) couldNotExercise(`test.mjs could not be started: ${tail(tests.output)}`);
if (!tests.ok) failed(`test.mjs fails: ${tail(tests.output)}`);

passed('repro.mjs fails against before/, passes against src/, "Hello  World" becomes "hello-world", and test.mjs passes');

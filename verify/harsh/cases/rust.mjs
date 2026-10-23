// Case: a change that touches native Rust (verify/harsh/fixtures/rust).
//
// The behaviour is measured by a test this case owns: the target is copied to a throwaway folder, an acceptance test
// that names both ends of the range is written into the copy, and cargo runs it there. The target's own suite is run
// too, and the ask's second half (a test for the overflow case) is checked in the target, because a fix without a
// test for the boundary is the habit this case exists to catch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { couldNotExercise, failed, have, passed, places, run, tail } from "../../lib/verdict.mjs";

const { target } = places(process.argv);

if (!have("cargo")) couldNotExercise("cargo is not on PATH, so the Rust case cannot be run");
if (!fs.existsSync(path.join(target, "Cargo.toml"))) failed("Cargo.toml is gone, so there is no crate to check");

const own = run("cargo", ["test", "--quiet", "--offline"], { cwd: target, timeout: 240_000 });
if (own.didNotStart) couldNotExercise(`cargo did not start: ${tail(own.output)}`);
if (!own.ok) failed(`the crate's own tests do not pass: ${tail(own.output)}`);

const copy = fs.mkdtempSync(path.join(os.tmpdir(), "harsh-rust-"));
try {
  fs.cpSync(target, copy, {
    recursive: true,
    filter: (from) => path.basename(from) !== "target",
  });
  fs.mkdirSync(path.join(copy, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(copy, "tests/acceptance_probe.rs"),
    [
      "use percent::clamp_percent;",
      "",
      "#[test]",
      "fn clamps_both_ends() {",
      "    assert_eq!(clamp_percent(150), 100);",
      "    assert_eq!(clamp_percent(-5), 0);",
      "    assert_eq!(clamp_percent(42), 42);",
      "}",
      "",
    ].join("\n"),
  );
  const probe = run("cargo", ["test", "--quiet", "--offline", "--test", "acceptance_probe"], {
    cwd: copy,
    timeout: 240_000,
  });
  if (probe.didNotStart) couldNotExercise(`cargo did not start: ${tail(probe.output)}`);
  if (!probe.ok) failed(`clamp_percent does not clamp both ends: ${tail(probe.output)}`);
} finally {
  fs.rmSync(copy, { recursive: true, force: true });
}

// The ask also says to add tests for 150 -> 100 and -5 -> 0. Checked in the target's own sources, since the probe
// above is the case's test and would pass without them.
const sources = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".rs")) sources.push(full);
  }
};
walk(path.join(target, "src"));
walk(path.join(target, "tests"));
const covered = sources.some((file) => {
  const text = fs.readFileSync(file, "utf8");
  return text.includes("#[test]") && text.includes("150") && text.includes("-5");
});
if (!covered) failed("clamp_percent is clamped, but no test for the boundary cases (150 and -5) was added");

passed("cargo test passes, clamp_percent(150) is 100 and clamp_percent(-5) is 0, and the boundary cases have tests");

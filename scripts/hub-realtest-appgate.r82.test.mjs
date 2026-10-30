// r82: --app-gate puts the scenario's check in the test copy's app data, where the app (gates.rs) runs it on a worker's
// done; the bench's own loop stays off.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appGateFiles, installAppGate } from "./hub-realtest-scenarios.mjs";
import { parseArgs } from "./hub-realtest.mjs";

const gate = { name: "Routes check", script: "tests/realtest/scenarios/gates/tally-routes.mjs", everySec: 15, signOff: ["DELETE /tallies/:id"] };

test("the check lands in app data by project id, with its script beside it, in the shape gates.rs reads", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "appgate-"));
  const files = appGateFiles(gate, dataDir, "tally");
  assert.equal(files.config, path.join(dataDir, "gates", "tally.json"));
  installAppGate(gate, files);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.config, "utf8")), { name: "Routes check", script: "tally-routes.mjs", signOff: ["DELETE /tallies/:id"] });
  assert.equal(fs.readFileSync(files.script, "utf8"), fs.readFileSync(gate.script, "utf8"));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("--app-gate is a flag, off unless passed", () => {
  assert.equal(parseArgs(["--grok-sub"]).appGate, false);
  assert.equal(parseArgs(["--grok-sub", "--app-gate"]).appGate, true);
});

test("with the app running the check, the bench never copies or runs it", () => {
  const src = fs.readFileSync(new URL("./hub-realtest-scenarios.mjs", import.meta.url), "utf8");
  assert.match(src, /const gateCopy = gate && ctx\.project && !ctx\.appGate \?/);
});

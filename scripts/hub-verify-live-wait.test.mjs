// The wait helper behind scripts/hub-verify-live.mjs: it polls for the state a check needs until a ceiling, so a busy
// Mac only costs time, never a verdict. Pure: a fake clock and a fake sleep, nothing launched.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_WAIT_CEILING_MS, parseWaitCeiling, waitFor } from "./hub-verify-live-wait.mjs";

/** A clock that only moves when the fake sleep is called, so timeouts are exact and instant. */
function fakeClock() {
  let t = 1_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    elapsed: () => t - 1_000,
  };
}

test("waitFor returns the first truthy value the read gives, without sleeping past it", async () => {
  const clock = fakeClock();
  let reads = 0;
  const value = await waitFor(
    () => {
      reads += 1;
      return reads === 3 ? { row: "ready" } : null;
    },
    { timeoutMs: 10_000, everyMs: 250, now: clock.now, sleep: clock.sleep },
  );
  assert.deepEqual(value, { row: "ready" });
  assert.equal(reads, 3);
  assert.equal(clock.elapsed(), 500, "two sleeps of 250 ms between three reads");
});

test("waitFor times out at the ceiling, returns null, and says what it waited for", async () => {
  const clock = fakeClock();
  const lines = [];
  let reads = 0;
  const value = await waitFor(
    () => {
      reads += 1;
      return null;
    },
    { timeoutMs: 2_000, everyMs: 500, label: "asker row in question", log: (line) => lines.push(line), now: clock.now, sleep: clock.sleep },
  );
  assert.equal(value, null);
  assert.equal(clock.elapsed(), 2_000, "it stops at the deadline, not after another full interval");
  assert.ok(reads >= 4 && reads <= 6, `polled until the deadline (${reads} reads)`);
  assert.equal(lines.length, 1, "a timeout is logged once");
  assert.match(lines[0], /asker row in question: not reached after 2000 ms/);
});

test("waitFor treats a read that throws as not ready yet, and names its last error on timeout", async () => {
  const clock = fakeClock();
  const lines = [];
  let reads = 0;
  const flaky = await waitFor(
    () => {
      reads += 1;
      if (reads < 3) throw new Error("database is locked");
      return "row";
    },
    { timeoutMs: 5_000, everyMs: 100, now: clock.now, sleep: clock.sleep, log: (line) => lines.push(line) },
  );
  assert.equal(flaky, "row", "a throw is not the end of the wait");
  assert.equal(lines.length, 0, "a success logs nothing");

  const never = await waitFor(
    () => {
      throw new Error("no such table");
    },
    { timeoutMs: 300, everyMs: 100, label: "db", log: (line) => lines.push(line), now: clock.now, sleep: clock.sleep },
  );
  assert.equal(never, null);
  assert.match(lines.at(-1), /db: not reached .*last error: no such table/);
});

test("waitFor with a ceiling of 0 reads once and gives up", async () => {
  const clock = fakeClock();
  let reads = 0;
  const value = await waitFor(
    () => {
      reads += 1;
      return false;
    },
    { timeoutMs: 0, now: clock.now, sleep: clock.sleep },
  );
  assert.equal(value, null);
  assert.equal(reads, 1);
  assert.equal(clock.elapsed(), 0);
});

test("the default ceiling is generous (120 s), and --wait-ceiling-ms or the env var can change it", () => {
  assert.equal(DEFAULT_WAIT_CEILING_MS, 120_000);
  assert.equal(parseWaitCeiling([], {}), 120_000);
  assert.equal(parseWaitCeiling(["--wait-ceiling-ms", "45000"], {}), 45_000);
  assert.equal(parseWaitCeiling([], { MONOCODE_VERIFY_WAIT_CEILING_MS: "300000" }), 300_000);
  assert.equal(parseWaitCeiling(["--wait-ceiling-ms", "60000"], { MONOCODE_VERIFY_WAIT_CEILING_MS: "300000" }), 60_000, "the flag wins");
  assert.equal(parseWaitCeiling(["--wait-ceiling-ms"], {}), 120_000, "a flag with no value is the default");
});

test("a ceiling that is not a positive number fails loudly rather than becoming a silent 0 or NaN", () => {
  assert.throws(() => parseWaitCeiling(["--wait-ceiling-ms", "soon"], {}), /--wait-ceiling-ms.*soon/);
  assert.throws(() => parseWaitCeiling(["--wait-ceiling-ms", "-5"], {}), /positive/);
  assert.throws(() => parseWaitCeiling([], { MONOCODE_VERIFY_WAIT_CEILING_MS: "0" }), /positive/);
});

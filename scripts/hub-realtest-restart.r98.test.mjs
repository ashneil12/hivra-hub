// r98 (B5): Ash quits the dev copy through its own Quit and opens it again in the background; nothing is ever killed.
import assert from "node:assert/strict";
import test from "node:test";
import { quitThenReopen } from "./hub-realtest-scenarios.mjs";

const until = async (read, timeoutMs) => {
  for (let i = 0; i <= Math.max(1, timeoutMs / 10); i++) {
    if (await read()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  return false;
};

test("quits through the app's own Quit, waits for it to close, then reopens", async () => {
  const calls = [];
  let up = true;
  const act = async (op) => {
    calls.push(op);
    up = false; // the app saves and exits on its own
    return { ok: true };
  };
  const result = await quitThenReopen({ act, pid: 11, alive: () => up, until, launch: async () => (calls.push("launch"), { pid: 22 }), waitMs: 100 });
  assert.deepEqual(calls, ["quit", "launch"]);
  assert.deepEqual(result, { ok: true, step: "reopen", pid: 22 });
});

test("an app that stays open is left alone: no kill, no second copy", async () => {
  let launched = false;
  const result = await quitThenReopen({ act: async () => ({ ok: true }), pid: 11, alive: () => true, until, launch: async () => ((launched = true), { pid: 22 }), waitMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.step, "quit");
  assert.match(result.why, /nothing was killed/);
  assert.equal(launched, false);
});

test("a refused quit reopens nothing", async () => {
  let launched = false;
  const result = await quitThenReopen({ act: async () => ({ ok: false, error: "unknown op quit" }), pid: 11, alive: () => true, until, launch: async () => ((launched = true), { pid: 22 }) });
  assert.equal(result.ok, false);
  assert.match(result.why, /unknown op quit/);
  assert.equal(launched, false);
});

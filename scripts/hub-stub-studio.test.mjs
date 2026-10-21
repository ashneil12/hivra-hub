// The stub's build wait (hub-stub-studio.mjs `run`): a call that waits longer than the build takes always gets the
// build, never "still building". Node can wake a timer a millisecond before Date.now() reaches its mark; here every
// timer wakes 1 ms early, the case that made hubStore's "follow the feed" test fail now and then.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startStub } from "./hub-stub-server.mjs";

test("a build waited on for longer than it takes is collected even when timers wake a millisecond early", async () => {
  const stub = await startStub({ buildMs: 120 });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.max(0, (ms ?? 0) - 1), ...rest);
  try {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${stub.url}/api/ash-hub-build-page`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${stub.token}` },
        body: JSON.stringify({ projectId: "hivra", monoId: "hivra-lead", prompt: `Sign-ups ${i}`, wait: 5 }),
      });
      const body = await res.json();
      assert.equal(body.ok, true, JSON.stringify(body));
      assert.ok(body.result.pageId, JSON.stringify(body));
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await stub.close();
  }
});

test("a build that takes longer than the wait still says it is building", async () => {
  const stub = await startStub({ buildMs: 400 });
  try {
    const res = await fetch(`${stub.url}/api/ash-hub-build-page`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${stub.token}` },
      body: JSON.stringify({ projectId: "hivra", monoId: "hivra-lead", prompt: "Sign-ups", wait: 0.1 }),
    });
    const body = await res.json();
    assert.equal(body.ok, false, JSON.stringify(body));
    assert.match(JSON.stringify(body), /still building this page/);
  } finally {
    await stub.close();
  }
});

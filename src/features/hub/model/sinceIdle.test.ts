// C9 idle test: "Since you were last active" covers only what happened after Ash's last real input (typing or a
// click), and it does not reset because the window was focused, scrolled or the app was reopened. The app's tracking
// (hubActivity.ts) reports to the stub Ash OS (scripts/hub-stub-server.mjs, the same 30-minute rule), and the app's
// share of the paragraph (appSince.ts) is written from the Since time that comes back.
import { afterEach, beforeEach, expect, it } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { bridgeTransport, createStubBridge } from "../../../dev/hubStubBridge";
import type { Delegation } from "../../monos/model/delegations";
import { appSinceText } from "./appSince";
import { startActivityTracking, type ActivityEnv } from "./hubActivity";
import { HubStore } from "./hubStore";

const H = 3600_000;
const BASE = Math.floor((Date.now() - 6 * H) / 1000) * 1000; // whole seconds, as Ash OS stamps times
let t = BASE;
let stub: Stub;
let store: HubStore;

/** A fake window on the shared clock `t`; timers run when the test says so. */
function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const timers: (() => void)[] = [];
  const env: ActivityEnv = {
    target: {
      addEventListener: (type, fn) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn as () => void),
      removeEventListener: (type, fn) => void listeners.get(type)?.delete(fn as () => void),
    },
    visible: () => true,
    now: () => t,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => undefined,
  };
  return { env, fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()), flush: () => timers.splice(0).forEach((fn) => fn()) };
}
async function waitFor(read: () => unknown, what: string) {
  const end = Date.now() + 4000;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const activeCalls = () => stub.calls.filter((c) => c.path === "/api/ash-hub-active").length;
const row = (id: string, createdAt: number): Delegation => ({
  id, ownerSession: "lead", ownerMono: "lead", batchId: null, parentId: null, rootId: id, childSession: `w-${id}`, requestId: id,
  generation: 1, project: "hub", title: `Example: job ${id}`, brief: null, goal: null, askIds: [], state: "running", errorClass: null,
  error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending", deliveryMessage: null,
  createdAt, updatedAt: createdAt, settledAt: null, log: [], version: 1, mirroredVersion: 0, mirrorError: null,
});

beforeEach(async () => {
  t = BASE;
  stub = await startStub({ pingMs: 200, now: () => t });
  stub.setActivity({ lastActive: null, since: null, sessionStart: null });
  store = new HubStore({ transport: bridgeTransport(createStubBridge(stub.url, () => stub.token)), coalesceMs: 10, minGapMs: 0, healthMs: 30, pollMs: 80, retryMs: [30, 60], stopGraceMs: 5 });
  store.start();
  await waitFor(() => store.getSnapshot().status === "ready", "ready");
});
afterEach(async () => {
  store.stop();
  await stub.close();
});

it("covers only events after Ash's last real input, and focus, scrolling or reopening the app don't reset it", async () => {
  let win = fakeWindow();
  let stop = startActivityTracking((at) => void store.reportActive(at), win.env);

  // Ash types at BASE, then clicks 10 minutes later: his last real input.
  win.fire("keydown");
  win.flush();
  await waitFor(() => activeCalls() === 1, "first report");
  t = BASE + 10 * 60_000;
  win.fire("click");
  win.flush();
  await waitFor(() => activeCalls() === 2, "the click");
  const lastInput = t;

  // Three hours with the app open and no real use: focus, scrolling, hovering, and the app closed and reopened.
  for (const step of [1, 2, 3]) {
    t = lastInput + step * H;
    for (const type of ["focus", "visibilitychange", "wheel", "scroll", "pointermove"]) win.fire(type);
    win.flush();
  }
  stop();
  win = fakeWindow(); // reopened
  stop = startActivityTracking((at) => void store.reportActive(at), win.env);
  win.fire("focus");
  win.flush();
  await new Promise((r) => setTimeout(r, 50));
  expect(activeCalls()).toBe(2); // nothing reported: none of that was use

  // He types again: Since is his last real input, not when the window was focused or the app reopened.
  t = lastInput + 3 * H + 5 * 60_000;
  win.fire("keydown");
  win.flush();
  await waitFor(() => Date.parse(store.getSnapshot().sinceAt ?? "") === lastInput, "Since at the last real input");
  stop();

  // The paragraph's events: only what happened after that input.
  const sinceMs = Date.parse(store.getSnapshot().sinceAt!);
  const text = appSinceText({
    sinceMs,
    rows: [row("before", lastInput - 60_000), row("after", lastInput + H)],
    stuck: [],
    changes: [],
    nameOf: () => "Example: Hub lead",
  });
  expect(text).toBe("The Lead handed out 1 job.");
});

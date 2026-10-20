// The store pulls the checker's notes for the app to deliver (hubStore.ts loadChecks; docs/PHASE-2-DESIGN.md decision 4):
// at boot and on feed topic `checks`, against the stub server's checker calls (scripts/hub-stub-checks.mjs).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { bridgeTransport, createStubBridge } from "../../../dev/hubStubBridge";
import type { HubCheck } from "./hubChecks";
import { HubStore } from "./hubStore";

const FAST = { coalesceMs: 10, minGapMs: 0, healthMs: 30, pollMs: 80, retryMs: [30, 60], stopGraceMs: 5 };

async function waitFor<T>(read: () => T | undefined | false, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let stub: Stub;
let store: HubStore;
let seen: HubCheck[][];

const dump = (id: string, owner = "mono:vg-game-lead") =>
  stub.addDump({
    id,
    owner,
    text: "Fix the save bug on mission two and make the HUD colours calmer.",
    asks: [{ id: "a_1020save01", title: "Fix the save bug", quote: "Fix the save bug on mission two", status: "working" }],
    suspect: [{ rule: "no_asks", ask_ids: [], why: "Only one of two asks was written down." }],
  });

beforeEach(async () => {
  stub = await startStub({ pingMs: 200 });
  store = new HubStore({ transport: bridgeTransport(createStubBridge(stub.url, () => stub.token)), ...FAST });
  seen = [];
  store.onChecks((checks) => seen.push([...checks]));
});
afterEach(async () => {
  store.stop();
  await stub.close();
});

describe("checks", () => {
  it("pulls the undelivered ones at boot, each with its [MonoCode check] turn", async () => {
    dump("d_1020a");
    stub.addCheck({ id: "ck_boot", dumpId: "d_1020a", owner: "mono:vg-game-lead", finding: "The HUD ask was not recorded. Is this right?" });
    store.start();
    const [check] = await waitFor(() => seen.at(-1)?.length && seen.at(-1), "checks at boot");
    expect(check).toMatchObject({ id: "ck_boot", dumpId: "d_1020a", owner: "mono:vg-game-lead", monoId: "vg-game-lead" });
    expect(check.prompt.startsWith("[MonoCode check]")).toBe(true);
    expect(check.prompt).toContain('ash_record check {"id": "ck_boot", "verdict": "right"');
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-checks")).toBe(true);
  });

  it("pulls again on feed topic `checks` when the checker notes a message", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    dump("d_1020b");
    stub.addCheck({ id: "ck_live", dumpId: "d_1020b", owner: "mono:vg-game-lead", finding: "Is the HUD part handled?" });
    await waitFor(() => seen.some((list) => list.some((c) => c.id === "ck_live")), "the new check");
  });

  it("tells Ash OS once a check was delivered, and the next pull leaves it out", async () => {
    dump("d_1020c");
    stub.addCheck({ id: "ck_1", dumpId: "d_1020c", owner: "mono:vg-game-lead", finding: "Is this right?" });
    store.start();
    await waitFor(() => seen.at(-1)?.length, "the check");
    await store.checksDelivered(["ck_1"]);
    expect(stub.checks.checks.get("ck_1")?.status).toBe("delivered");
    expect(stub.calls.filter((c) => c.path === "/api/ash-hub-check-delivered")).toHaveLength(1);
    await store.loadChecks();
    expect(seen.at(-1)).toEqual([]);
  });

  it("lists nothing for a chat outside the hub (it hears on its own next ash-os call)", async () => {
    dump("d_1020d", "claude:9f1c2e");
    stub.addCheck({ id: "ck_out", dumpId: "d_1020d", owner: "claude:9f1c2e", finding: "Is this right?" });
    store.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-checks"), "a pull");
    await store.loadChecks();
    expect(seen.flat().map((c) => c.id)).not.toContain("ck_out");
  });

  it("an older Ash OS without checks is not an outage", async () => {
    const old = new HubStore({
      transport: {
        call: async (action: string) => {
          if (action === "ash-hub-checks") throw Object.assign(new Error("Unknown hub action"), { kind: "refused", message: "Unknown hub action" });
          return bridgeTransport(createStubBridge(stub.url, () => stub.token)).call(action, {});
        },
        openFeed: () => () => undefined,
      },
      ...FAST,
    });
    old.start();
    await waitFor(() => old.getSnapshot().status === "ready", "ready");
    await old.loadChecks();
    expect(old.getSnapshot().status).toBe("ready");
    old.stop();
  });
});

describe("the stub's checker lanes (the studio's, ashos/checker.py)", () => {
  const call = async (action: string, body: Record<string, unknown>) => {
    const res = await fetch(`${stub.url}/api/ash-hub-${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stub.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; result?: Record<string, unknown>; error?: string };
  };

  it("only the checker reads its queue and leaves notes; only the owning chat answers, once", async () => {
    dump("d_1020e");
    expect((await call("checker-queue", { _caller: { mono_id: "vg-game-lead", role: "lead" } })).error).toMatch(/Only the checker/);
    const queue = await call("checker-queue", { _caller: { mono_id: "checker", role: "checker" } });
    expect((queue.result!.dumps as Array<{ dump_id: string }>).map((d) => d.dump_id)).toEqual(["d_1020e"]);
    const note = await call("checker-note", { _caller: { mono_id: "checker", role: "checker" }, dump_id: "d_1020e", finding: "The HUD ask was not recorded. Is this right?" });
    const id = (note.result!.check as { id: string }).id;
    expect((await call("check-answer", { _caller: { mono_id: "checker", role: "checker" }, id, verdict: "right" })).error).toMatch(/Only the chat/);
    expect((await call("check-answer", { _caller: { mono_id: "hivra-lead", role: "lead" }, id, verdict: "right" })).error).toMatch(/is for mono:vg-game-lead/);
    const answer = await call("check-answer", { _caller: { mono_id: "vg-game-lead", role: "lead" }, id, verdict: "right", note: "Ash said the HUD can wait." });
    expect(answer.result).toMatchObject({ changed: true, check: { status: "right", answer: "Ash said the HUD can wait." } });
    expect((await call("check-answer", { _caller: { mono_id: "vg-game-lead", role: "lead" }, id, verdict: "fixed" })).result).toMatchObject({ changed: false });
  });
});

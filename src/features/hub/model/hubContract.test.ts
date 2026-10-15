// The app and the stub must speak what Ash OS really speaks. The fixture is the REAL ashos.hub.Hub's own answers
// (scripts/hub-real-shapes.py runs it on a temporary ledger). Two checks: the store reads the real answers correctly,
// and the stub never invents a field the real service doesn't send.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { bridgeTransport, createStubBridge } from "../../../dev/hubStubBridge";
import { HubStore } from "./hubStore";
import type { HubTransport } from "./hubTransport";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const real = JSON.parse(readFileSync(join(__dirname, "fixtures", "ash-os-real-shapes.json"), "utf8")) as Record<string, Json>;

/** Maps keyed by an id (a project's or a Mono's): the id is not a field. */
const BY_ID = new Set([".projects", ".byProject", ".byMono"]);

/** Every key path in a value; array items share one path, so a list of rows contributes the union of their keys. */
function paths(value: Json, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) paths(item, `${prefix}[]`).forEach((p) => out.add(p));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const key = BY_ID.has(prefix) ? "*" : k;
      out.add(`${prefix}.${key}`);
      paths(v, `${prefix}.${key}`).forEach((p) => out.add(p));
    }
  }
  return out;
}

describe("the store reads what the real Ash OS sends", () => {
  const answers: Record<string, Json> = {
    "ash-hub-projects": real.projects,
    "ash-hub-needs": real.needs,
    "ash-hub-since": real.since,
    "ash-hub-active": real.active,
  };
  const transport: HubTransport = {
    call: async <T,>(action: string) => answers[action] as T,
    openFeed: () => () => undefined,
  };

  it("turns the real projects, Needs and Since into the screens' data", async () => {
    const store = new HubStore({ transport, minGapMs: 0 });
    store.start();
    await new Promise((r) => setTimeout(r, 50));
    const snap = store.getSnapshot();
    store.stop();
    expect(snap.status).toBe("ready");
    expect(snap.projects.map((p) => p.id)).toEqual(["ash", "hivra", "nibbii", "vg-game"]);
    expect(snap.projects[0]).toMatchObject({ id: "ash", shortName: "Harness", iconShape: "folder", folder: null });
    expect(snap.projects[3]).toMatchObject({ id: "vg-game", name: "EXO", folder: "/tmp/hub-test/vg-game" });
    // five shown, three under Later, in Ash OS's own order; every row has its one action
    const exo = snap.needs["vg-game"];
    expect(exo.shown).toHaveLength(5);
    expect(exo.later).toHaveLength(3);
    for (const n of [...exo.shown, ...exo.later]) {
      expect(["start", "open", "sign_in", "see_options"]).toContain(n.actionType);
      expect(n.actionLabel).toBeTruthy();
      expect(n.since).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    expect(exo.later.every((n) => n.later)).toBe(true);
    // a question answered elsewhere arrives as a ticked row with its reason
    // a row that was answered before the app ever showed it is not shown as a tick: only rows Ash saw open tick off
    expect(snap.needs.hivra).toEqual({ shown: [], later: [] });
    // Since: ISO time, plain text, per-project text
    expect(snap.sinceAt).toBe((real.since as { sinceAt: string }).sinceAt);
    expect(snap.since?.overall.plainText).toContain("need you");
    expect(snap.since?.byProject["vg-game"].plainText).toContain("8 things need you");
    expect(snap.since?.pending).toBe(true);
  });

  it("new Needs in the real shape (with microsecond timestamps) read as dates", () => {
    const stamp = (real.needs as { projects: Array<{ shown: Array<{ since: string }> }> }).projects[0].shown[0].since;
    expect(Number.isNaN(new Date(stamp).getTime())).toBe(false);
  });
});

describe("the stub only says what the real service says", () => {
  let stub: Stub;
  let transport: HubTransport;
  beforeAll(async () => {
    stub = await startStub();
    transport = bridgeTransport(createStubBridge(stub.url, () => stub.token));
    // make the stub show its optional fields too
    stub.doneNeed("q1");
  });
  afterAll(() => stub.close());

  for (const [action, key, payload] of [
    ["ash-hub-projects", "projects", {}],
    ["ash-hub-needs", "needs", {}],
    ["ash-hub-since", "since", { wait: 0 }],
    ["ash-hub-active", "active", { at: new Date().toISOString() }],
    ["ash-hub-mono-projects", "mono_projects", {}],
  ] as const) {
    it(`${action}: no field the real service doesn't send`, async () => {
      const got = await transport.call<Json>(action, payload);
      const extra = [...paths(got)].filter((p) => !paths(real[key]).has(p));
      expect(extra).toEqual([]);
    });
  }

  it("the feed's events carry the real service's fields", async () => {
    stub.addNeed({ id: "z", projectId: "hivra", title: "Example: z" });
    const got = await transport.call<Json>("ash-hub-events", { after: 0 });
    const extra = [...paths(got)].filter((p) => !paths(real.events).has(p));
    expect(extra).toEqual([]);
  });
});

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

  it("ash-hub-delegation: keeps the newest version of the app's copy, as ashos/hub.py delegation does", async () => {
    const row = { id: "t-1", version: 2, state: "running", owner_mono: "vg-game-lead", owner_session: "mono-exo", ask_ids: [] };
    const first = await transport.call<Json>("ash-hub-delegation", row);
    expect(first).toEqual({ id: "t-1", applied: true, version: 2, state: "running", owner: "mono:vg-game-lead", linked: [], moved: [], refused: [] });
    const late = await transport.call<Json>("ash-hub-delegation", { ...row, version: 1, state: "completed" });
    expect(late).toMatchObject({ applied: false, version: 2, state: "running" });
    await transport.call("ash-hub-delegation", { ...row, version: 3, state: "completed" });
    expect(stub.delegations.get("t-1")).toMatchObject({ version: 3, state: "completed" });
    await expect(transport.call("ash-hub-delegation", { ...row, state: "lost" })).rejects.toThrow(/state/);
    // Not built in the studio yet: the app's outbox has to live with this answer.
    await expect(transport.call("ash-hub-chat-bind", { provider_session: "p", chat_id: "c" })).rejects.toThrow(/Unknown hub action/);
  });

  it("the feed's events carry the real service's fields", async () => {
    stub.addNeed({ id: "z", projectId: "hivra", title: "Example: z" });
    const got = await transport.call<Json>("ash-hub-events", { after: 0 });
    const extra = [...paths(got)].filter((p) => !paths(real.events).has(p));
    expect(extra).toEqual([]);
  });
});

// ---- jobs, older and need-seen: the real hub code on the jobs branch (not live yet) --------------------------------------
const realJobs = JSON.parse(readFileSync(join(__dirname, "fixtures", "ash-os-real-shapes-jobs.json"), "utf8")) as Record<string, Json>;

describe("the store reads what the real jobs code sends", () => {
  const answers: Record<string, Json> = {
    "ash-hub-projects": real.projects,
    "ash-hub-needs": realJobs.needs_with_older,
    "ash-hub-since": real.since,
    "ash-hub-jobs": realJobs.jobs,
    "ash-hub-job-options": realJobs.job_options,
  };
  const transport: HubTransport = { call: async <T,>(a: string) => answers[a] as T, openFeed: () => () => undefined };

  it("reads Being built: groups under their Lead, every state, nothing invented", async () => {
    const store = new HubStore({ transport, minGapMs: 0 });
    store.start();
    await new Promise((r) => setTimeout(r, 50));
    const snap = store.getSnapshot();
    expect(snap.jobs.map((g) => g.leadName)).toEqual(["Hivra lead", "Nibbii (no lead yet)"]);
    const hivra = snap.jobs[0].jobs;
    expect(hivra.map((j) => j.state).sort()).toEqual(["checking", "done", "lead_gave_up", "sent_to_lead", "working"]);
    const sent = hivra.find((j) => j.state === "sent_to_lead")!;
    expect(sent).toMatchObject({ circle: "amber", word: "Stuck", reason: "The disk was full twice.", sentText: "Sent to coding team lead at 4:51am", gotIt: { text: "Got it" } });
    const gaveUp = hivra.find((j) => j.state === "lead_gave_up")!;
    expect(gaveUp).toMatchObject({ circle: "red", word: "Needs you", tried: ["once on its own", "splitting the job", "a different worker"] });
    expect(snap.jobs[1].jobs[0]).toMatchObject({ state: "stuck", lead: null, leadName: null });
    const sheet = await store.jobOptions(gaveUp.id);
    expect(sheet.options.map((o) => o.id)).toEqual(["try_tonight", "try_different", "pause", "drop"]);
    expect(sheet.options[1]).toMatchObject({ needsText: true, placeholder: "A hint for the coding team lead" });
    store.stop();
  });

  it("reads the older group and the Looks-right and given-up rows from the real Needs", async () => {
    const store = new HubStore({ transport, minGapMs: 0 });
    store.start();
    await new Promise((r) => setTimeout(r, 50));
    const snap = store.getSnapshot();
    expect(snap.older).toHaveLength(1);
    expect(snap.older[0]).toMatchObject({ projectId: "vg-game", title: "Old question from an old chat?" });
    const looks = Object.values(snap.needs).flatMap((r) => [...r.shown, ...r.later]).find((n) => n.id.startsWith("s:"))!;
    expect(looks).toMatchObject({ canMarkSeen: true, actionType: "open" });
    // the older question is in no Needs list, so in no count
    expect(Object.values(snap.needs).flatMap((r) => [...r.shown, ...r.later]).some((n) => n.id === snap.older[0].id)).toBe(false);
    store.stop();
  });
});

describe("the stub's jobs only say what the real jobs code says", () => {
  let stub: Stub;
  let transport: HubTransport;
  beforeAll(async () => {
    stub = await startStub({ jobs: true });
    transport = bridgeTransport(createStubBridge(stub.url, () => stub.token));
  });
  afterAll(() => stub.close());

  const known = (...keys: string[]) => new Set(keys.flatMap((k) => [...paths(realJobs[k])]));
  it("ash-hub-jobs", async () => {
    const got = await transport.call<Json>("ash-hub-jobs", {});
    expect([...paths(got)].filter((p) => !known("jobs", "jobs_hivra", "jobs_after").has(p))).toEqual([]);
  });
  it("ash-hub-job-options", async () => {
    const got = await transport.call<Json>("ash-hub-job-options", { job_id: "j_sender" });
    expect([...paths(got)].filter((p) => !known("job_options").has(p))).toEqual([]);
  });
  it("ash-hub-needs with older rows, a given-up job and Looks right", async () => {
    const got = await transport.call<Json>("ash-hub-needs", {});
    expect([...paths(got)].filter((p) => !new Set([...known("needs_with_older", "needs_with_gave_up_job"), ...paths(real.needs)]).has(p))).toEqual([]);
  });
  it("ash-hub-need-seen and ash-hub-job-act (pause)", async () => {
    const seen = await transport.call<Json>("ash-hub-need-seen", { id: "s:a_cannon" });
    expect([...paths(seen)].filter((p) => !known("need_seen").has(p))).toEqual([]);
    const act = await transport.call<Json>("ash-hub-job-act", { job_id: "j_sender", option: "pause" });
    expect([...paths(act)].filter((p) => !known("job_act_pause").has(p))).toEqual([]);
  });
});

// ---- questions and answers: the real hub code on branch ash-os-hub-answer ------------------------------------------------
const realAnswer = JSON.parse(readFileSync(join(__dirname, "fixtures", "ash-os-real-shapes-answer.json"), "utf8")) as Record<string, Json>;

describe("the store reads what the real answer code sends", () => {
  it("reads a question with options, one without, and one with nothing to agree to", async () => {
    const replies: Record<string, Json> = {
      "q:with": realAnswer.question_with_options, "q:none": realAnswer.question_no_options, "q:bare": realAnswer.question_bare,
    };
    const transport: HubTransport = { call: async <T,>(_a: string, p?: Record<string, unknown>) => replies[String(p?.id)] as T, openFeed: () => () => undefined };
    const store = new HubStore({ transport });
    const withOptions = await store.question("q:with");
    expect(withOptions.options).toEqual([{ label: "Shield first" }, { label: "Combo first", detail: "bigger" }, { label: "Second weapon set first" }]);
    expect(withOptions.recommendation).toEqual({ text: "Do the shield first. It is missing.", optionIndex: 0 });
    expect(withOptions.quickAnswers.map((q) => q.id)).toEqual(["agree", "drop", "park"]);
    expect((await store.question("q:none")).recommendation.optionIndex).toBeNull();
    expect((await store.question("q:bare")).quickAnswers.map((q) => q.id)).toEqual(["drop", "park"]);
  });

  it("an answer the model could not read yet leaves the row open and says the words are saved", async () => {
    const transport: HubTransport = {
      call: async <T,>(a: string) => (a === "ash-hub-answer" ? realAnswer.answer_choice_model_down : { projects: [] }) as T,
      openFeed: () => () => undefined,
    };
    const store = new HubStore({ transport });
    store.start();
    store.answer("q:with", { choice: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getSnapshot().answering["q:with"]).toMatchObject({ sending: false, closed: false, receipt: expect.stringMatching(/^Saved your answer/) });
    store.stop();
  });
});

describe("the stub's questions only say what the real answer code says", () => {
  let stub: Stub;
  let transport: HubTransport;
  beforeAll(async () => {
    stub = await startStub();
    transport = bridgeTransport(createStubBridge(stub.url, () => stub.token));
  });
  afterAll(() => stub.close());
  const known = (...keys: string[]) => new Set(keys.flatMap((k) => [...paths(realAnswer[k])]));
  it("ash-hub-question and ash-hub-answer", async () => {
    for (const id of ["q2", "q4"]) {
      const got = await transport.call<Json>("ash-hub-question", { id });
      expect([...paths(got)].filter((p) => !known("question_with_options", "question_no_options", "question_bare").has(p))).toEqual([]);
    }
    const answered = await transport.call<Json>("ash-hub-answer", { id: "q2", quick: "park" });
    expect([...paths(answered)].filter((p) => !known("answer_quick_park", "answer_choice_model_down").has(p))).toEqual([]);
  });
});

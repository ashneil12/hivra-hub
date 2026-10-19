// The live store against the stub server (scripts/hub-stub-server.mjs): real HTTP, real server-sent events.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { bridgeTransport, createStubBridge } from "../../../dev/hubStubBridge";
import { HubStore, mergeStable } from "./hubStore";
import type { Need } from "./types";

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
const stores: HubStore[] = [];

function makeStore(url = stub.url, getToken: () => string = () => stub.token): HubStore {
  const s = new HubStore({ transport: bridgeTransport(createStubBridge(url, getToken)), ...FAST });
  stores.push(s);
  return s;
}
const needIds = (s: HubStore, pid: string) => s.getSnapshot().needs[pid]?.shown.map((n) => n.id) ?? [];
const needsCalls = () => stub.calls.filter((c) => c.path === "/api/ash-hub-needs").length;

beforeEach(async () => {
  stub = await startStub({ pingMs: 200 });
  store = makeStore();
});
afterEach(async () => {
  stores.splice(0).forEach((s) => s.stop());
  await stub.close();
});

describe("first read", () => {
  it("loads projects, Needs and Since from Ash OS and says ready", async () => {
    store.start();
    expect(store.getSnapshot().status).toBe("loading");
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const snap = store.getSnapshot();
    expect(snap.projects.map((p) => p.id)).toEqual(["vg-game", "hivra", "nibbii", "hub"]);
    expect(snap.projects[0]).toEqual({ id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "folder", folder: "/Users/example/Projects/vg-game" });
    expect(snap.projects[3].folder).toBe("/Users/example/Projects/monocode-hub");
    await waitFor(() => store.getSnapshot().since, "since");
    expect(store.getSnapshot().since?.overall.plainText).toContain("Example:");
  });

  it("never calls the old 927 KB page call, only ash-hub-* actions, with the key and a local Host", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().since, "since");
    expect(stub.calls.length).toBeGreaterThan(2);
    for (const c of stub.calls) {
      expect(c.path).toMatch(/^\/api\/ash-hub-[a-z-]+$/);
      expect(c.headers.authorization).toBe(`Bearer ${stub.token}`);
      expect(c.headers.host).toBe(`127.0.0.1:${stub.port}`);
    }
  });

  it("keeps Ash OS's own time strings as ISO timestamps, not display text", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().since, "since");
    const snap = store.getSnapshot();
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    expect(snap.sinceAt).toMatch(iso);
    expect(snap.lastActiveAt).toMatch(iso);
    for (const rows of Object.values(snap.needs)) for (const n of [...rows.shown, ...rows.later]) expect(n.since).toMatch(iso);
  });

  it("shows at most 5 Needs per project and files the rest under Later, so counts match the rows", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const org = store.getSnapshot().needs.hub;
    expect(org.shown).toHaveLength(5);
    expect(org.later.map((n) => n.id)).toEqual(["q9"]);
    expect(org.later[0].later).toBe(true);
    expect(org.shown.some((n) => n.later)).toBe(false);
  });

  it("starts the feed at the number the first read returned", async () => {
    store.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-events"), "feed");
    const call = stub.calls.find((c) => c.path === "/api/ash-hub-events")!;
    expect(call.query.after).toBe(String(stub.latest));
    expect(call.query.stream).toBe("1");
  });
});

describe("live changes land in place", () => {
  it("a new Need joins at the bottom of its group and nothing above it moves", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const before = needIds(store, "vg-game");
    const firstRowObject = store.getSnapshot().needs["vg-game"].shown[0];
    // rank 0 would sort first if the store re-sorted
    stub.addNeed({ id: "q10", projectId: "vg-game", title: "Example: urgent thing", rank: 0 });
    await waitFor(() => needIds(store, "vg-game").includes("q10"), "new need");
    expect(needIds(store, "vg-game")).toEqual([...before, "q10"]);
    expect(store.getSnapshot().needs["vg-game"].shown[0]).toEqual(firstRowObject);
  });

  it("a Need answered somewhere else ticks itself off where it stands, and stops counting", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.addNeed({ id: "q10", projectId: "hub", title: "Example: sixth thing", rank: 9 });
    await waitFor(() => store.getSnapshot().needs.hub.later.some((n) => n.id === "q10"), "sixth need under Later");
    const order = needIds(store, "hub");
    expect(order).toEqual(["q4", "q5", "q6", "q7", "q8"]);
    stub.doneNeed("q5", "answered");
    const ticked = await waitFor(() => store.getSnapshot().needs.hub.shown.find((n) => n.id === "q5" && n.state === "done"), "tick");
    expect(ticked.doneReason).toBe("answered");
    // the Need waiting under Later moves up to the bottom of the list; the ticked row and the rest did not move
    await waitFor(() => needIds(store, "hub").includes("q10"), "promotion");
    expect(needIds(store, "hub")).toEqual([...order, "q10"]);
    expect(store.getSnapshot().needs.hub.later.map((n) => n.id)).toEqual(["q9"]);
  });

  it("ticked rows stay until Ash leaves the page, then go and stay gone while Ash OS still lists them", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.doneNeed("q1");
    await waitFor(() => store.getSnapshot().needs["vg-game"].shown.some((n) => n.state === "done"), "tick");
    store.dismissDone();
    expect(needIds(store, "vg-game")).toEqual(["q2"]);
    stub.addNeed({ id: "q11", projectId: "vg-game", title: "Example: another" });
    await waitFor(() => needIds(store, "vg-game").includes("q11"), "refresh");
    expect(needIds(store, "vg-game")).toEqual(["q2", "q11"]);
  });

  it("a burst of changes becomes one read of Needs, not one per event", async () => {
    store.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-events"), "feed");
    await new Promise((r) => setTimeout(r, 50));
    const before = needsCalls();
    for (let i = 0; i < 8; i++) stub.addNeed({ id: `burst${i}`, projectId: "hivra", title: `Example: burst ${i}` });
    const has = (id: string) => { const r = store.getSnapshot().needs.hivra; return [...r.shown, ...r.later].some((n) => n.id === id); };
    await waitFor(() => has("burst7"), "all burst needs");
    await new Promise((r) => setTimeout(r, 100));
    expect(needsCalls() - before).toBeLessThanOrEqual(2);
  });

  it("a steady stream of ledger writes costs at most one Needs read per gap, not one per write", async () => {
    const slow = new HubStore({ transport: bridgeTransport(createStubBridge(stub.url, () => stub.token)), ...FAST, minGapMs: 300 });
    stores.push(slow);
    slow.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-events"), "feed");
    await new Promise((r) => setTimeout(r, 60));
    const before = needsCalls();
    for (let i = 0; i < 12; i++) {
      stub.emit("ask.updated", `a${i}`);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 350));
    const reads = needsCalls() - before;
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBeLessThanOrEqual(5); // 12 writes over about half a second, one read per 300 ms at most
  });

  it("a new project appears on the strip without touching the others", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.addProject({ id: "side", name: "Side thing" });
    await waitFor(() => store.getSnapshot().projects.some((p) => p.id === "side"), "project");
    expect(store.getSnapshot().projects.map((p) => p.id)).toEqual(["vg-game", "hivra", "nibbii", "hub", "side"]);
    expect(store.getSnapshot().projects.at(-1)?.iconShape).toBe("folder");
  });

  it("the Since paragraph is swapped in when the model's text is ready, without a reload", async () => {
    await stub.close();
    stub = await startStub({ pendingSinceOnce: true, pingMs: 200 });
    store = makeStore();
    store.start();
    await waitFor(() => store.getSnapshot().since?.pending, "pending since");
    expect(store.getSnapshot().since?.overall.plainText).toMatch(/on their way/);
    stub.finishPendingSince();
    await waitFor(() => store.getSnapshot().since?.pending === false, "finished since");
    expect(store.getSnapshot().since?.overall.plainText).toContain("the hub has five decisions");
  });

  it("Since for one project and for all of them come from the same read", async () => {
    store.start();
    const since = await waitFor(() => store.getSnapshot().since, "since");
    expect(since.byProject["vg-game"].plainText).toContain("new level");
    expect(since.byProject.nibbii).toBeUndefined();
  });
});

describe("questions", () => {
  const states = () => store.getSnapshot().answering;
  it("reads a question by its Needs row id: options, the recommendation and the quick answers", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const q = await store.question("q3");
    expect(q).toMatchObject({ id: "q3", questionId: "q3", status: "open", question: "Example: pick the waitlist headline", recommendation: { optionIndex: 1 } });
    expect(q.options.map((o) => o.label)).toEqual(["Headline A", "Headline B"]);
    expect(q.quickAnswers.map((a) => a.id)).toEqual(["agree", "drop", "park"]);
    const none = await store.question("q4");
    expect(none.options).toEqual([]);
  });

  it("an answer goes in the background: Sending…, then the receipt, and the row ticks off only when it closed", async () => {
    await stub.close();
    stub = await startStub({ pingMs: 200, answerDelayMs: 300 });
    store = makeStore();
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    store.answer("q3", { choice: 1 });
    expect(states().q3).toEqual({ sending: true });
    expect(store.getSnapshot().needs.hivra.shown.find((n) => n.id === "q3")?.state).toBe("open");
    await waitFor(() => states().q3 && !states().q3.sending, "answer back");
    expect(states().q3).toMatchObject({ sending: false, closed: true, receipt: "Saved to memory as your decision." });
    expect(stub.calls.filter((c) => c.path === "/api/ash-hub-answer")).toHaveLength(1);
    await waitFor(() => store.getSnapshot().needs.hivra.shown.find((n) => n.id === "q3")?.state === "done", "ticked");
  });

  it("an answer Ash OS could not close leaves the row open with the receipt", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    store.answer("q2", { text: "something unclear" });
    await waitFor(() => states().q2 && !states().q2.sending, "answer back");
    expect(states().q2).toMatchObject({ closed: false, receipt: expect.stringMatching(/stays open/) });
    expect(store.getSnapshot().needs["vg-game"].shown.find((n) => n.id === "q2")?.state).toBe("open");
  });

  it("a refused answer comes back in plain words, and leaving the page clears finished receipts", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    store.answer("q4", { quick: "agree", text: "x" } as never);
    await waitFor(() => states().q4 && !states().q4.sending, "refused");
    expect(states().q4.problem).toBe("A quick answer goes alone.");
    store.dismissDone();
    expect(states().q4).toBeUndefined();
  });
});

describe("Ash's activity", () => {
  it("tells Ash OS the time of the real input, and picks up the new Since time after a gap", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().since, "since");
    const before = store.getSnapshot().sinceAt;
    stub.setActivity({ lastActive: Date.now() - 2 * 3600_000 });
    const at = new Date(Date.now() - 5000);
    await store.reportActive(at);
    const call = stub.calls.filter((c) => c.path === "/api/ash-hub-active").at(-1);
    expect(call).toBeTruthy();
    await waitFor(() => store.getSnapshot().sinceAt !== before, "new since time");
  });

  it("an activity failure is never shown", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    await stub.close();
    await expect(store.reportActive(new Date())).resolves.toBeUndefined();
  });
});

describe("Ash OS restarts", () => {
  it("reads everything again after the 'code version' event, with the new key", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const before = stub.calls.filter((c) => c.path === "/api/ash-hub-projects").length;
    stub.state.projects.push({ id: "late", name: "Late", shortName: "Late", iconShape: "folder", folder: null, workOwner: "ash_os", status: "active" });
    stub.restart({ newToken: "second-key-after-restart" });
    await waitFor(() => store.getSnapshot().projects.some((p) => p.id === "late"), "reload after restart");
    expect(stub.calls.filter((c) => c.path === "/api/ash-hub-projects").length).toBeGreaterThan(before);
  });

  it("goes unreachable when Ash OS stops, keeps what it had, and recovers by itself when it is back", async () => {
    const port = stub.port;
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const had = store.getSnapshot().projects;
    await stub.close();
    const down = await waitFor(() => (store.getSnapshot().status === "unreachable" ? store.getSnapshot() : undefined), "unreachable");
    expect(down.message).toBe("Ash OS isn't running.");
    expect(down.projects).toEqual(had);
    stub = await startStub({ port, token: "after-restart-key" });
    // the store reads the key fresh each time, like the Rust plugin
    (store as unknown as { t: unknown }).t = bridgeTransport(createStubBridge(stub.url, () => stub.token));
    await waitFor(() => store.getSnapshot().status === "ready", "recovered", 6000);
  });

  it("starts as unreachable, never as example data, when Ash OS was never there", async () => {
    const dead = await startStub();
    const url = dead.url;
    await dead.close();
    const lonely = makeStore(url);
    lonely.start();
    const snap = await waitFor(() => (lonely.getSnapshot().status === "unreachable" ? lonely.getSnapshot() : undefined), "unreachable");
    expect(snap.projects).toEqual([]);
    expect(snap.needs).toEqual({});
    expect(snap.since).toBeUndefined();
    expect(snap.loadedOnce).toBe(false);
  });

  it("the retry button reads again at once and shows 'trying' meanwhile", async () => {
    const dead = await startStub();
    const url = dead.url;
    const port = dead.port;
    await dead.close();
    const lonely = new HubStore({ transport: bridgeTransport(createStubBridge(url, () => "any")), ...FAST, retryMs: [60_000] });
    stores.push(lonely);
    lonely.start();
    await waitFor(() => lonely.getSnapshot().status === "unreachable", "unreachable");
    stub = await startStub({ port, token: "any" });
    lonely.retry();
    expect(lonely.getSnapshot().retrying).toBe(true);
    await waitFor(() => lonely.getSnapshot().status === "ready", "ready after retry");
    expect(lonely.getSnapshot().retrying).toBe(false);
  });

  it("an old service that doesn't know the hub calls is shown as down, not as an empty app", async () => {
    stub.state.projects.length = 0;
    const odd = new HubStore({
      transport: {
        call: async () => {
          throw Object.assign(new Error("Unknown hub action"), { kind: "error", message: "Unknown hub action" });
        },
        openFeed: () => () => undefined,
      },
      ...FAST,
      retryMs: [60_000],
    });
    stores.push(odd);
    odd.start();
    await waitFor(() => odd.getSnapshot().status === "unreachable", "unreachable");
    expect(odd.getSnapshot().loadedOnce).toBe(false);
  });

  it("a ledger restore (cursor ahead of Ash OS) makes it read everything again", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    stub.state.projects.push({ id: "after-restore", name: "After restore", shortName: "AR", iconShape: "folder", folder: null, workOwner: "ash_os", status: "active" });
    stub.rewindTo(3);
    stub.restart();
    await waitFor(() => store.getSnapshot().projects.some((p) => p.id === "after-restore"), "reload after reset");
  });
});

describe("the feed drops but Ash OS stays", () => {
  it("falls back to polling and still brings in changes", async () => {
    store.start();
    await waitFor(() => stub.calls.some((c) => c.path === "/api/ash-hub-events"), "feed");
    // sever the stream only (no code-version event), then change something while it is down
    stub.closeStreams();
    stub.addNeed({ id: "poll1", projectId: "nibbii", title: "Example: seen by polling or the reconnected feed" });
    await waitFor(() => needIds(store, "nibbii").includes("poll1"), "change after the drop");
  });
});

describe("mergeStable", () => {
  const n = (id: string, extra: Partial<Need> = {}): Need => ({ id, projectId: "p", title: id, why: "", actionType: "open", actionLabel: "Open", state: "open", ...extra });
  it("keeps the old order, ticks a finished row in place, and adds new rows last", () => {
    const prev = [n("a"), n("b"), n("c")];
    const out = mergeStable(prev, [n("c"), n("d"), n("a")], new Map([["b", n("b", { state: "done" })]]), new Set());
    expect(out.map((x) => `${x.id}:${x.state}`)).toEqual(["a:open", "b:done", "c:open", "d:open"]);
  });
  it("drops a row Ash OS no longer lists, and one Ash has left behind", () => {
    const prev = [n("a"), n("b", { state: "done" }), n("c")];
    expect(mergeStable(prev, [n("a")], new Map(), new Set(["b"])).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("older questions, Looks right and jobs", () => {
  beforeEach(async () => {
    await stub.close();
    stub = await startStub({ jobs: true, pingMs: 200 });
    store = makeStore();
  });
  const jobsOf = (pid: string) => store.getSnapshot().jobs.filter((g) => g.projectId === pid).flatMap((g) => g.jobs);

  it("keeps older questions apart: collapsed data, in no Needs list and no count", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().older.length, "older");
    const snap = store.getSnapshot();
    expect(snap.older.map((n) => n.id).sort()).toEqual(["q:o1", "q:o2", "q:o3"]);
    expect(snap.older).toHaveLength(3);
    expect(snap.older.every((n) => n.later)).toBe(true);
    for (const rows of Object.values(snap.needs)) for (const n of [...rows.shown, ...rows.later]) expect(snap.older.some((o) => o.id === n.id)).toBe(false);
  });

  it("marks a Looks-right row seen through ash-hub-need-seen and the row ticks off", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const row = store.getSnapshot().needs.nibbii.shown.find((n) => n.id === "s:a_cannon")!;
    expect(row.canMarkSeen).toBe(true);
    expect(store.getSnapshot().needs.hivra.shown.find((n) => n.id === "j:j_sender")?.canMarkSeen).toBeUndefined();
    await store.markNeedSeen("s:a_cannon");
    const ticked = store.getSnapshot().needs.nibbii.shown.find((n) => n.id === "s:a_cannon")!;
    expect(ticked).toMatchObject({ state: "done", doneReason: "seen" });
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-need-seen")).toBe(true);
  });

  it("accepts a Looks-right row through ash-hub-need-accept when Ash OS names the action 'accept'", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    const row = store.getSnapshot().needs.nibbii.shown.find((n) => n.id === "s:a_cannon")!;
    expect(row).toMatchObject({ actionType: "accept", actionLabel: "Looks right" });
    await store.acceptNeed("s:a_cannon");
    expect(store.getSnapshot().needs.nibbii.shown.find((n) => n.id === "s:a_cannon")).toMatchObject({ state: "done", doneReason: "accepted or changed" });
    await expect(store.acceptNeed("s:a_legacy")).rejects.toMatchObject({ message: expect.stringMatching(/Only finished work/) });
  });

  it("the badge count is the real Needs count, live, and a ticked row stops counting", async () => {
    const data = (await import("./liveHubData")).createLiveHubData(store);
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    expect(data.needsCount!("hub")).toBe(6);
    expect(data.needsCount!("hivra")).toBe(2);
    stub.doneNeed("q4");
    await waitFor(() => data.needsCount!("hub") === 5, "count after tick");
  });

  it("refuses to mark anything but a Looks-right row seen, in plain words", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().status === "ready", "ready");
    await expect(store.markNeedSeen("q1")).rejects.toMatchObject({ message: expect.stringMatching(/Only a Looks-right row/) });
  });

  it("reads jobs grouped under their Lead; a given-up job is a red Needs row with its job id", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().jobs.length, "jobs");
    const groups = store.getSnapshot().jobs;
    expect(groups.map((g) => g.leadName)).toEqual(["EXO lead", "Hivra lead", "Nibbii (no lead yet)"]);
    expect(jobsOf("hivra").map((j) => j.state)).toEqual(["working", "sent_to_lead", "lead_gave_up", "done"]);
    const need = store.getSnapshot().needs.hivra.shown.find((n) => n.id === "j:j_sender")!;
    expect(need).toMatchObject({ circle: "red", word: "Needs you", jobId: "j_sender", actionType: "see_options" });
    const sent = jobsOf("hivra").find((j) => j.state === "sent_to_lead")!;
    expect(sent).toMatchObject({ circle: "amber", word: "Stuck", sentText: expect.stringMatching(/^Sent to coding team lead at/), gotIt: { text: "Got it" } });
  });

  it("a job moving state never moves the rows: order stays, new jobs join the end of their Lead's group", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().jobs.length, "jobs");
    const order = jobsOf("vg-game").map((j) => j.id);
    stub.setJob("j_save", { state: "working", lastActiveAt: new Date().toISOString() }, "hub.job.active");
    await waitFor(() => jobsOf("vg-game").find((j) => j.id === "j_save")?.state === "working", "job moved");
    expect(jobsOf("vg-game").map((j) => j.id)).toEqual(order);
    stub.addJob({ id: "j_new", projectId: "vg-game", title: "Another job", leadName: "EXO lead" });
    await waitFor(() => jobsOf("vg-game").some((j) => j.id === "j_new"), "new job");
    expect(jobsOf("vg-game").map((j) => j.id)).toEqual([...order, "j_new"]);
  });

  it("stuck jobs reach the screens as amber rows with no button, and the given-up one is not among them", async () => {
    const data = (await import("./liveHubData")).createLiveHubData(store);
    store.start();
    await waitFor(() => store.getSnapshot().jobs.length, "jobs");
    const stuck = data.listStuck("hivra");
    expect(stuck.map((s) => s.title)).toEqual(["Moving the nightly backup"]);
    expect(stuck[0]).toMatchObject({ state: "stuck", detail: "The disk was full twice.", note: expect.stringMatching(/^Sent to coding team lead at .* · Got it$/) });
    expect(data.listStuck("nibbii").map((s) => s.title)).toEqual(["Tidying the sound files"]);
    expect(data.listStuck("nibbii")[0].note).toBeUndefined();
  });

  it("the See options sheet comes from Ash OS and Ash's pick moves the job and ticks the row off", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().jobs.length, "jobs");
    const sheet = await store.jobOptions("j_sender");
    expect(sheet.options.map((o) => o.label)).toEqual(["Try again tonight", "Try it a different way…", "Pause this job", "Drop it"]);
    expect(sheet.options.filter((o) => o.needsText).map((o) => o.id)).toEqual(["try_different"]);
    await expect(store.jobAct("j_sender", "try_different")).rejects.toMatchObject({ message: "Say what to try." });
    await store.jobAct("j_sender", "try_different", "use the other login");
    const call = stub.calls.filter((c) => c.path === "/api/ash-hub-job-act").at(-1)!;
    expect(call).toBeTruthy();
    expect(store.getSnapshot().needs.hivra.shown.find((n) => n.id === "j:j_sender")?.state).toBe("done");
    expect(jobsOf("hivra").find((j) => j.id === "j_sender")?.state).toBe("sent_to_lead");
    await expect(store.jobOptions("j_sender")).rejects.toMatchObject({ message: "That job isn't waiting on you." });
  });

  it("Drop it removes the job from Being built; Pause parks it", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().jobs.length, "jobs");
    await store.jobAct("j_sender", "pause");
    expect(jobsOf("hivra").find((j) => j.id === "j_sender")?.state).toBe("parked");
    stub.setJob("j_mail", { state: "lead_gave_up", circle: "red", word: "Needs you", why: "x" });
    await waitFor(() => jobsOf("hivra").find((j) => j.id === "j_mail")?.state === "lead_gave_up", "gave up");
    await store.jobAct("j_mail", "drop");
    expect(jobsOf("hivra").some((j) => j.id === "j_mail")).toBe(false);
  });

  it("a finished job stays with its dot until Ash has seen it, then leaves Being built", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().jobs.length, "jobs");
    expect(jobsOf("hivra").find((j) => j.id === "j_footer")).toMatchObject({ state: "done", seen: false });
    store.markJobsSeen(["j_footer"]);
    await waitFor(() => !jobsOf("hivra").some((j) => j.id === "j_footer"), "gone");
    expect(stub.calls.some((c) => c.path === "/api/ash-hub-job-seen")).toBe(true);
  });

  it("an Ash OS without jobs yet is simply nothing being built, not an outage", async () => {
    await stub.close();
    stub = await startStub({ pingMs: 200 });
    const real = bridgeTransport(createStubBridge(stub.url, () => stub.token));
    const noJobs = new HubStore({
      ...FAST,
      transport: { ...real, call: (a, p) => (a === "ash-hub-jobs" ? Promise.reject(Object.assign(new Error("Unknown hub action"), { kind: "error", message: "Unknown hub action" })) : real.call(a, p)) },
    });
    stores.push(noJobs);
    noJobs.start();
    await waitFor(() => noJobs.getSnapshot().status === "ready", "ready");
    await new Promise((r) => setTimeout(r, 80));
    expect(noJobs.getSnapshot().jobs).toEqual([]);
    expect(noJobs.getSnapshot().status).toBe("ready");
  });
});

describe("pages, the Today board and the change history", () => {
  const call = (action: string, payload: Record<string, unknown>) => bridgeTransport(createStubBridge(stub.url, () => stub.token)).call(action, payload);

  it("are read with everything else, as Ash OS sends them", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().today, "layout");
    expect(store.getSnapshot().today?.map((s) => s.id)).toEqual(["since", "setup", "needs", "being-built"]);
    await waitFor(() => store.getSnapshot().pages, "pages");
    expect(store.getSnapshot().pages).toEqual([]);
    await waitFor(() => store.getSnapshot().changes, "changes");
    expect(store.getSnapshot().changes).toEqual([]);
  });

  it("follow the feed: a page kept and a change applied elsewhere are read again (only those slices)", async () => {
    store.start();
    await waitFor(() => store.getSnapshot().changes, "first read");
    const built = (await call("ash-hub-build-page", { projectId: "hivra", monoId: "hivra-lead", prompt: "Sign-ups", wait: 5 })) as { pageId: string };
    await call("ash-hub-page-update", { pageId: built.pageId, kept: true });
    await waitFor(() => store.getSnapshot().pages?.length === 1, "kept page read from the feed");
    const preview = (await call("ash-hub-change-preview", { flow: "today", projectId: "today", monoId: "projects-manager", prompt: "put my page on Today", wait: 5 })) as { previewId: string };
    const needsBefore = needsCalls();
    await call("ash-hub-change-apply", { previewId: preview.previewId });
    await waitFor(() => store.getSnapshot().today?.some((s) => s.kind === "page"), "board read from the feed");
    await waitFor(() => store.getSnapshot().changes?.[0]?.state === "applied", "history read from the feed");
    expect(store.getSnapshot().changes?.[0]).toMatchObject({ previewId: preview.previewId, flow: "today", by: "Projects Manager", state: "applied" });
    expect(needsCalls()).toBe(needsBefore);
  });

  it("an Ash OS without them leaves them unset, not an outage", async () => {
    await stub.close();
    stub = await startStub({ pingMs: 200 });
    const real = bridgeTransport(createStubBridge(stub.url, () => stub.token));
    const unknown = Object.assign(new Error("Unknown hub action"), { kind: "error", message: "Unknown hub action" });
    const old = new HubStore({
      ...FAST,
      transport: { ...real, call: (a, p) => (["ash-hub-pages", "ash-hub-layout", "ash-hub-changes"].includes(a) ? Promise.reject(unknown) : real.call(a, p)) },
    });
    stores.push(old);
    old.start();
    await waitFor(() => old.getSnapshot().status === "ready", "ready");
    await new Promise((r) => setTimeout(r, 80));
    const snap = old.getSnapshot();
    expect([snap.status, snap.pages, snap.today, snap.changes]).toEqual(["ready", undefined, undefined, undefined]);
  });
});

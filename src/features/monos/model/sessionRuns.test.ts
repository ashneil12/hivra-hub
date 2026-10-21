// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { noteSessionRuns, resetSessionRuns, runsAt } from "./sessionRuns";

beforeEach(() => resetSessionRuns());

it("keeps when each chat was running, and asks which were running at a moment", () => {
  noteSessionRuns([{ id: "a", busy: true }, { id: "b" }], 1_000);
  noteSessionRuns([{ id: "a", busy: true }, { id: "b", busy: true }], 2_000);
  noteSessionRuns([{ id: "a" }, { id: "b", busy: true }], 3_000);
  noteSessionRuns([{ id: "a" }, { id: "b" }], 4_000);
  expect(runsAt(500, 0).map((r) => r.sessionId)).toEqual([]);
  expect(runsAt(1_500, 0).map((r) => r.sessionId)).toEqual(["a"]);
  expect(runsAt(2_500, 0).map((r) => r.sessionId)).toEqual(["a", "b"]);
  expect(runsAt(3_500, 0).map((r) => r.sessionId)).toEqual(["b"]);
  expect(runsAt(10_000, 0)).toEqual([]);
  // A run still going counts up to now.
  noteSessionRuns([{ id: "c", busy: true }], 20_000);
  expect(runsAt(25_000, 0, 30_000).map((r) => r.sessionId)).toEqual(["c"]);
});

it("saves a running chat every heartbeat, so a reload ends its run within seconds of when it was last seen", async () => {
  const { reloadSessionRunsForTest, RUN_HEARTBEAT_MS } = await import("./sessionRuns");
  noteSessionRuns([{ id: "a", busy: true }], 1_000);
  // Heartbeats with nothing new on screen (App.tsx's timer).
  for (let t = 1_000 + RUN_HEARTBEAT_MS; t <= 21_000; t += RUN_HEARTBEAT_MS) noteSessionRuns([{ id: "a", busy: true }], t);
  reloadSessionRunsForTest();
  noteSessionRuns([{ id: "a" }], 23_000);
  expect(runsAt(20_500, 0, 30_000).map((r) => r.sessionId)).toEqual(["a"]);
  expect(runsAt(24_000, 0, 30_000)).toEqual([]);
});

it("joins the app process's record: a turn still open counts until now, one closed counts up to its end", async () => {
  const { refreshProcessRuns, setProcessRunSource, liveProcessRuns } = await import("./sessionRuns");
  setProcessRunSource(async () => [
    { sessionId: "p", pid: 1, start: 100, turns: [{ start: 1_000, end: 2_000 }, { start: 5_000 }] },
    { sessionId: "q", pid: 2, start: 100, end: 3_000, turns: [{ start: 1_500, end: 3_000 }] },
  ]);
  await refreshProcessRuns(10_000);
  expect(runsAt(1_700, 0, 10_000).map((r) => r.sessionId)).toEqual(["p", "q"]);
  expect(runsAt(3_500, 0, 10_000)).toEqual([]);
  expect(runsAt(9_000, 0, 10_000).map((r) => r.sessionId)).toEqual(["p"]);
  expect(liveProcessRuns().map((r) => r.sessionId)).toEqual(["p"]);
  // The page's record and the process's for the same chat count once.
  noteSessionRuns([{ id: "p", busy: true }], 8_000);
  expect(runsAt(9_000, 0, 10_000).map((r) => r.sessionId)).toEqual(["p"]);
  // An unreadable record keeps the last copy.
  setProcessRunSource(async () => {
    throw new Error("no host");
  });
  await refreshProcessRuns(10_000);
  expect(runsAt(9_000, 0, 10_000).map((r) => r.sessionId)).toEqual(["p"]);
});

import { expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { LateHomeLoad, createHomeLoader, fetchHome, loadNeedsYouCount, mergeHomeLoad, type HomeSource } from "./load";
import type { HomeStorage } from "./store";

function source(over: Partial<HomeSource> = {}): HomeSource {
  const disk = memoryDisk();
  const storage: HomeStorage = { get: () => null, set: () => undefined };
  return {
    decisions: async () => [{ project: "crew", decisionKey: "ship", question: "Should we ship?", state: "open", createdAt: 1 }],
    tasks: async () => [{ id: "m1", projectId: "crew", title: "Write the notes", status: "In progress", source: "agent", assignee: "Ada", needsYou: false, createdAt: 2 }],
    docs: async () => [{ id: "d1", title: "Plan", lastOpenedAt: 3, trashedAt: null }],
    projects: () => [{ id: "crew", name: "Crew", folder: "C:\\work\\crew" }, { id: "crew", name: "Duplicate" }],
    catalog: async () => [{ plugin: "..", panelId: "no" }, { plugin: "my-panels", panelId: "board", title: "Example board", spec: { kind: "bespoke", title: "Example board", html: "<p>Example</p>", permissions: [] } }],
    disk,
    storage,
    ...over,
  };
}

it("reads every project key, drops a late result, and does not turn a timeout into an empty home", async () => {
  const asked: string[] = [];
  const base = source({
    tasks: async (project) => {
      asked.push(project);
      if (project === "C:\\work\\crew") {
        return [{ id: "folder", projectId: "C:\\work\\crew", title: "Filed on the path", status: "In review", needsYou: false, createdAt: 4 }];
      }
      return [
        { id: "m1", projectId: "crew", title: "Write the notes", status: "In progress", source: "agent", assignee: null, createdAt: 2 },
        { id: "m1", title: "Duplicate" },
        null,
      ];
    },
  });
  const snap = await fetchHome(base, () => 5);
  expect(asked).toEqual(["crew", "C:\\work\\crew"]);
  expect(snap.projects).toHaveLength(1);
  expect(snap.tasks.map((task) => task.id)).toEqual(["m1", "folder"]);
  expect(snap.catalog.map((panel) => panel.panelId)).toEqual(["board"]);
  expect(snap.decisions).toHaveLength(1);

  let first: (value: unknown) => void = () => undefined;
  let calls = 0;
  const slow = source({
    tasks: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { first = resolve; });
      return Promise.resolve([{ id: "fresh", projectId: "crew", title: "Fresh", status: "In progress", source: "agent", needsYou: false, createdAt: 9 }]);
    },
    projects: () => [{ id: "crew", name: "Crew", folder: null }],
  });
  const loader = createHomeLoader(slow, () => 6);
  const stale = loader.load();
  loader.invalidate();
  const fresh = loader.load();
  first([{ id: "stale", projectId: "crew", title: "Stale", status: "In progress", source: "agent", needsYou: false, createdAt: 1 }]);
  await expect(stale).rejects.toBeInstanceOf(LateHomeLoad);
  const next = await fresh;
  expect(next.tasks.map((task) => task.id)).toEqual(["fresh"]);

  const previous = snap;
  let shown = previous;
  try {
    await fetchHome(source({ tasks: async () => { throw new Error("timeout"); } }), () => 7);
    shown = await fetchHome(source(), () => 7);
  } catch {
    /* a timeout is not a final failure, and it is not an empty list */
  }
  expect(shown.tasks.map((task) => task.id)).toEqual(["m1", "folder"]);
  await expect(loadNeedsYouCount(source({ decisions: async () => { throw new Error("timeout"); } }))).rejects.toThrow(/timeout/);

  const down = {
    async readDoc() {
      throw new Error("timeout");
    },
    async read() {
      throw new Error("timeout");
    },
    async write() {
      return 1;
    },
  };
  const mirror = {
    get: (key: string) => (key === "monocode:home" ? JSON.stringify({ savedAt: 5, recent: [{ id: "c1", title: "Lead chat", projectId: "crew", openedAt: 4 }] }) : null),
    set: () => undefined,
  };
  const kept = await fetchHome(source({ disk: down, storage: mirror }), () => 8);
  expect(kept.storeUnavailable).toBe(true);
  expect(kept.chats.map((chat) => chat.id)).toEqual(["c1"]);
  expect(kept.decisions).toHaveLength(1);
  await expect(fetchHome(source({ disk: down }), () => 8)).rejects.toThrow(/unavailable/);

  const settled = { ...kept, storeUnavailable: false, chats: [{ id: "newer", title: "Newer", projectId: "crew", openedAt: 9 }] };
  const merged = mergeHomeLoad(settled, kept);
  expect(merged.retry).toBe(true);
  expect(merged.snap.chats.map((chat) => chat.id)).toEqual(["newer"]);
  expect(merged.snap.decisions).toHaveLength(1);
  expect(mergeHomeLoad(null, { ...kept, storeUnavailable: false }).retry).toBe(false);
});

it("counts needs you only after a real list, and a removed task is not counted", async () => {
  const count = await loadNeedsYouCount(source({
    tasks: async () => [
      { id: "ask", projectId: "crew", title: "Which font?", status: "In progress", needsYou: true, createdAt: 2 },
      { id: "gone", projectId: "crew", title: "Removed", status: "In review", trashedAt: 1, createdAt: 3 },
    ],
  }));
  expect(count).toBe(2);
  const none = await loadNeedsYouCount(source({ decisions: async () => [], tasks: async () => [], projects: () => [] }));
  expect(none).toBe(0);
});

it("keeps the morning summary switch when the store times out", async () => {
  const base = source();
  await base.disk.write("home", { dailySummary: false, savedAt: 3, recent: [] }, 0);
  const snap = await fetchHome(base, () => 4);
  expect(snap.summaryOff).toBe(true);
  const down = {
    async readDoc() {
      throw new Error("timeout");
    },
    async read() {
      throw new Error("timeout");
    },
    async write() {
      return 1;
    },
  };
  const mirror = {
    get: (key: string) => (key === "monocode:home" ? JSON.stringify({ savedAt: 1, dailySummary: false, recent: [] }) : null),
    set: () => undefined,
  };
  const kept = await fetchHome(source({ disk: down, storage: mirror }), () => 8);
  expect(kept.summaryOff).toBe(true);
  const settled = { ...snap, storeUnavailable: false as const };
  const timed = { ...kept, summaryOff: false };
  expect(mergeHomeLoad(settled, timed).snap.summaryOff).toBe(true);
});

it("a native read that never answers times out instead of leaving Home blank forever", async () => {
  vi.useFakeTimers();
  try {
    const loader = createHomeLoader(source({ catalog: () => new Promise(() => {}) }));
    const result = expect(loader.load()).rejects.toThrow(/too long/i);
    await vi.advanceTimersByTimeAsync(11000);
    await result;
  } finally {
    vi.useRealTimers();
  }
});

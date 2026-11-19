import { expect, it } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { PORTABLE_SETTINGS } from "../../portable/model/setupDoc";
import { pinPanel } from "./arrangement";
import { HOME_DOC_KEY, HOME_SETTING_KEY, changeHome, noteOpenedChat, parseHomeDoc, readHome, withChat, type HomeStorage } from "./store";

function storage(seed: Record<string, string> = {}): HomeStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

const chat = { id: "c1", title: "Lead\r\nchat", projectId: "crew", openedAt: 90 };

it("keeps the home arrangement in the portable settings", () => {
  expect(PORTABLE_SETTINGS).toContain(HOME_SETTING_KEY);
});

it("a pin and a chat from two windows both land", async () => {
  const disk = memoryDisk();
  let reads = 0;
  let release: () => void = () => undefined;
  let sawStale: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = new Promise<void>((resolve) => {
    sawStale = resolve;
  });
  const slow = {
    async readDoc(key: string) {
      const doc = await disk.readDoc(key);
      if (reads === 0) {
        reads += 1;
        sawStale();
        await gate;
      }
      return doc;
    },
    read: disk.read.bind(disk),
    write: disk.write.bind(disk),
  };
  const first = storage();
  const second = storage();
  const pending = changeHome(slow, second, (doc) => withChat(doc, chat), () => 20);
  await stale;
  const pinned = await changeHome(disk, first, (doc) => ({ ...doc, arrangement: pinPanel(doc.arrangement, "my-panels", "board") }), () => 10);
  expect(pinned?.doc.arrangement.order.some((ref) => ref.kind === "panel")).toBe(true);
  release();
  const noted = await pending;
  expect(noted).not.toBeNull();
  expect(noted?.doc.recent.map((item) => item.title)).toEqual(["Lead chat"]);
  expect(noted?.doc.arrangement.order.some((ref) => ref.kind === "panel")).toBe(true);
  const saved = disk.docs.get(HOME_DOC_KEY) as { recent: { id: string }[]; arrangement: { order: { kind: string }[] } };
  expect(saved.recent.map((item) => item.id)).toEqual(["c1"]);
  expect(saved.arrangement.order.some((ref) => ref.kind === "panel")).toBe(true);
  expect(second.values.get(HOME_SETTING_KEY)).toContain("my-panels");
  const again = await readHome(disk, first, () => 30);
  expect(again.doc.recent).toHaveLength(1);
  expect(again.doc.arrangement.order.some((ref) => ref.kind === "panel")).toBe(true);
  expect(again.rev).toBe(noted?.rev);
});

it("a timeout writes nothing and is not an empty home", async () => {
  let writes = 0;
  const disk = {
    async readDoc() {
      throw new Error("timeout");
    },
    async read() {
      throw new Error("timeout");
    },
    async write() {
      writes += 1;
      return 1;
    },
  };
  const box = storage({ [HOME_SETTING_KEY]: JSON.stringify({ savedAt: 5, recent: [chat] }) });
  expect(await changeHome(disk, box, (doc) => withChat(doc, chat))).toBeNull();
  expect(writes).toBe(0);
  expect(box.values.get(HOME_SETTING_KEY)).toContain("c1");
  const read = await readHome(disk, box, () => 9);
  expect(read.unavailable).toBe(true);
  expect(read.doc.savedAt).toBe(5);
  expect(read.doc.recent.map((item) => item.id)).toEqual(["c1"]);
  expect(read.rev).toBe(0);
  expect(writes).toBe(0);
});

it("a timed-out read with no mirror is a failure, not an empty home", async () => {
  const disk = {
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
  await expect(readHome(disk, storage(), () => 9)).rejects.toThrow(/unavailable/);
});

it("keeps a morning summary that was turned off, and drops anything that is not false", async () => {
  expect(parseHomeDoc({ dailySummary: "false" }).dailySummary).toBeUndefined();
  expect(parseHomeDoc({ dailySummary: false }).dailySummary).toBe(false);
  const disk = memoryDisk();
  const box = storage();
  const off = await changeHome(disk, box, (doc) => ({ ...doc, dailySummary: false }), () => 4);
  expect(off?.doc.dailySummary).toBe(false);
  const arranged = await changeHome(disk, box, (doc) => ({ ...doc, arrangement: doc.arrangement }), () => 5);
  expect(arranged?.doc.dailySummary).toBe(false);
  const on = await changeHome(disk, box, (doc) => {
    const { dailySummary: _flag, ...rest } = doc;
    return rest;
  }, () => 6);
  expect(on?.doc.dailySummary).toBeUndefined();
});

it("tries a timed-out read again, and a chat survives a full pass of failures", async () => {
  let reads = 0;
  const recovering = {
    async readDoc() {
      reads += 1;
      if (reads < 3) throw new Error("timeout");
      return { value: { savedAt: 1, recent: [], arrangement: { order: [], hidden: [], savedAt: 1 } }, rev: 2 };
    },
    async read() {
      return null;
    },
    async write() {
      return 4;
    },
  };
  const recovered = await changeHome(recovering, storage(), (doc) => withChat(doc, chat), () => 8);
  expect(recovered?.doc.recent.map((item) => item.id)).toEqual(["c1"]);
  expect(reads).toBe(3);

  let stubborn = 0;
  const disk = {
    async readDoc() {
      stubborn += 1;
      if (stubborn <= 5) throw new Error("timeout");
      return { value: null, rev: 0 };
    },
    async read() {
      return null;
    },
    async write() {
      return 1;
    },
  };
  const noted = await noteOpenedChat(chat, disk, storage(), async () => undefined);
  expect(noted?.doc.recent.map((item) => item.id)).toEqual(["c1"]);
  expect(stubborn).toBeGreaterThan(5);
});

it("five refused writes give up without a mirror, and a thrown change writes nothing", async () => {
  const disk = memoryDisk({ [HOME_DOC_KEY]: { savedAt: 3, arrangement: { order: [], hidden: [], savedAt: 3 }, recent: [] } });
  const box = storage();
  const refusing = {
    readDoc: disk.readDoc.bind(disk),
    read: disk.read.bind(disk),
    async write() {
      return null;
    },
  };
  expect(await changeHome(refusing, box, (doc) => withChat(doc, chat), () => 4)).toBeNull();
  expect(box.values.has(HOME_SETTING_KEY)).toBe(false);
  expect(disk.docs.get(HOME_DOC_KEY)).toMatchObject({ savedAt: 3 });
  const thrown = await changeHome(disk, box, () => {
    throw new Error("nope");
  });
  expect(thrown).toBeNull();
  expect((disk.docs.get(HOME_DOC_KEY) as { savedAt: number }).savedAt).toBe(3);
});

it("a no-op change does not write", async () => {
  const disk = memoryDisk();
  const box = storage();
  const first = await changeHome(disk, box, (doc) => doc, () => 1);
  expect(first?.rev).toBe(0);
  expect(disk.docs.has(HOME_DOC_KEY)).toBe(false);
});

it("garbage on disk falls back, and a newer mirror is adopted without dropping a newer hub write", async () => {
  const disk = memoryDisk({
    [HOME_DOC_KEY]: { arrangement: { order: "nope", hidden: ["..\\x"] }, recent: [{ id: "../secret", openedAt: 1, title: "No" }, { id: "old", title: "Old", openedAt: 2 }, { id: "old", title: "Dup", openedAt: 3 }], savedAt: 10 },
  });
  const garbage = storage({ [HOME_SETTING_KEY]: "{" });
  const kept = await readHome(disk, garbage, () => 99);
  expect(kept.doc.savedAt).toBe(10);
  expect(kept.doc.recent.map((item) => item.id)).toEqual(["old"]);
  expect(kept.doc.arrangement.order.map((ref) => ref.kind === "builtin" && ref.id)).toEqual(["needs-you", "projects", "moving-now", "recent"]);
  expect(kept.rev).toBe(1);

  const mirror = storage({
    [HOME_SETTING_KEY]: JSON.stringify({
      savedAt: 50,
      arrangement: { order: [{ kind: "panel", plugin: "my-panels", panelId: "board" }, { kind: "panel", plugin: "..", panelId: "no" }], hidden: [], savedAt: 50 },
      recent: [chat],
    }),
  });
  const adopted = await readHome(disk, mirror, () => 60);
  expect(adopted.doc.recent[0].title).toBe("Lead chat");
  expect(adopted.doc.arrangement.order.some((ref) => ref.kind === "panel" && ref.panelId === "board")).toBe(true);
  expect(adopted.doc.arrangement.order.some((ref) => ref.kind === "panel" && ref.panelId === "no")).toBe(false);
  expect(adopted.doc.savedAt).toBe(60);

  const newerHub = memoryDisk({ [HOME_DOC_KEY]: { savedAt: 80, arrangement: { order: [], hidden: [], savedAt: 80 }, recent: [{ id: "hub", title: "Hub", projectId: "", openedAt: 8 }] } });
  const olderMirror = storage({ [HOME_SETTING_KEY]: JSON.stringify({ savedAt: 50, recent: [chat], arrangement: { savedAt: 50 } }) });
  const revBefore = (await newerHub.readDoc(HOME_DOC_KEY)).rev;
  const stayed = await readHome(newerHub, olderMirror, () => 90);
  expect(stayed.doc.recent.map((item) => item.id)).toEqual(["hub"]);
  expect(stayed.rev).toBe(revBefore);
});

it("a mirror that fails to save still leaves the hub document", async () => {
  const disk = memoryDisk();
  const box: HomeStorage = { get: () => null, set: () => { throw new Error("full"); } };
  const written = await changeHome(disk, box, (doc) => withChat(doc, chat), () => 7);
  expect(written?.doc.recent).toHaveLength(1);
  expect(disk.docs.get(HOME_DOC_KEY)).toMatchObject({ savedAt: 7 });
});

it("notes a chat through the same check, and drops an empty id", async () => {
  const disk = memoryDisk();
  const box = storage();
  const noted = await noteOpenedChat(chat, disk, box);
  expect(noted?.doc.recent[0].title).toBe("Lead chat");
  const again = await noteOpenedChat({ ...chat, title: "Renamed", openedAt: 100 }, disk, box);
  expect(again?.doc.recent).toHaveLength(1);
  expect(again?.doc.recent[0].title).toBe("Renamed");
  expect(await noteOpenedChat({ id: "  ", title: "No", projectId: "", openedAt: 1 }, disk, box)).toMatchObject({ rev: again?.rev });
  expect(parseHomeDoc(disk.docs.get(HOME_DOC_KEY)).recent).toHaveLength(1);
});

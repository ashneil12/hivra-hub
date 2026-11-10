import { describe, expect, it } from "vitest";
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { draftId, placeDrafts } from "./programme";
import { SCOUT_DEFAULTS } from "./settings";
import { changeScoutDoc, parseScoutDoc, readScoutSettings, ScoutStoreUnavailable, SCOUT_DOC_KEY } from "./store";

function diskThatConflictsOnce(): LocalHubDisk & { docs: Map<string, unknown> } {
  const disk = memoryDisk();
  let bumped = false;
  const write = disk.write.bind(disk);
  disk.write = async (key, value, rev) => {
    if (!bumped && key === SCOUT_DOC_KEY) {
      bumped = true;
      await write(key, { settings: { enabled: true, time: "22:00", maxDrafts: 1, watchFolder: null }, rows: [], briefs: {} }, rev);
      return null;
    }
    return write(key, value, rev);
  };
  return disk;
}

describe("overnight scout store", () => {
  it("reads a missing or broken document as off, and does not invent rows", async () => {
    const disk = memoryDisk();
    expect((await readScoutSettings(disk)).enabled).toBe(false);
    expect(parseScoutDoc({ settings: { enabled: "yes" }, rows: "nope" }).settings).toEqual(SCOUT_DEFAULTS);
    expect(parseScoutDoc({ rows: [{ briefPath: "/tmp/secret.md", id: "draft-a", title: "A", status: "queued" }] }).rows).toEqual([]);
  });

  it("keeps a queued draft and a parked one across a later read", async () => {
    const disk = memoryDisk();
    const placed = placeDrafts({
      enabled: true,
      maxDrafts: 3,
      existing: [],
      briefs: {},
      candidates: [
        { source: "firstmate", title: "Queue notes", text: "A note from the table." },
        { source: "firstmate", title: "Auth for the desk", text: "Add authentication." },
      ],
      now: 10,
      projectId: "crew",
    });
    await changeScoutDoc(disk, () => ({ settings: { ...SCOUT_DEFAULTS, enabled: true }, rows: placed.rows, briefs: placed.briefs }), 10);
    const again = await readScoutSettings(disk);
    expect(again.enabled).toBe(true);
    const saved = parseScoutDoc((await disk.readDoc(SCOUT_DOC_KEY)).value, 10);
    expect(saved.rows.map((row) => row.status)).toEqual(["queued", "parked"]);
    expect(saved.rows[1].securityPark).toBe(true);
    expect(saved.briefs[draftId("firstmate", "Auth for the desk")]).toContain("does not start work");
    expect(JSON.stringify(saved).includes(`/${"Users"}/`)).toBe(false);
  });

  it("retries when another window wrote first, and a dead store is not an empty save", async () => {
    const disk = diskThatConflictsOnce();
    const saved = await changeScoutDoc(disk, (doc) => ({
      ...doc,
      settings: { ...doc.settings, maxDrafts: 2 },
      rows: doc.rows,
    }));
    expect(saved.settings.enabled).toBe(true);
    expect(saved.settings.time).toBe("22:00");
    expect(saved.settings.maxDrafts).toBe(2);

    const dead: LocalHubDisk = {
      async read() {
        return null;
      },
      async readDoc() {
        throw new Error("timed out");
      },
      async write() {
        throw new Error("timed out");
      },
    };
    await expect(changeScoutDoc(dead, (doc) => doc)).rejects.toBeInstanceOf(ScoutStoreUnavailable);
    await expect(readScoutSettings(dead)).rejects.toBeInstanceOf(ScoutStoreUnavailable);
  });
});

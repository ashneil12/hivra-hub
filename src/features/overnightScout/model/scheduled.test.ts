import { describe, expect, it } from "vitest";
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { briefRelativePath, draftId, type ProgrammeRow } from "./programme";
import { SCOUT_DEFAULTS } from "./settings";
import { runScheduledScout } from "./scheduled";
import { changeScoutDoc, SCOUT_DOC_KEY, type ScoutDoc } from "./store";

const SOURCES = `
## The sources

| Source | Licence | What Hivra takes | How | Packages |
| --- | --- | --- | --- | --- |
| [firstmate](https://example.com/firstmate) | MIT | durable queue | Port | 10 |
| [Orbit](https://example.com/orbit) | Apache-2.0 | board | Vendor | 70 |

## Vision to packages
`;

const watch = ["firstmate: Show the queue", "firstmate: Auth for the desk", "unknown: invent a product", "Orbit: Board notes"].join(
  "\n",
);

const cwd = "/work/my crew";
const folder = "/notes/approved";
const on = { ...SCOUT_DEFAULTS, enabled: true, maxDrafts: 2, watchFolder: folder };

function reader(files: Record<string, string | Error>): (path: string) => Promise<string> {
  return async (path) => {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      throw new Error(`${path}: No such file or directory (os error 2)`);
    }
    const value = files[path];
    if (value instanceof Error) throw value;
    return value ?? "";
  };
}

const files = {
  [`${cwd}/docs/hivra/SOURCES.md`]: SOURCES,
  [`${folder}/watch.md`]: watch,
};

async function saved(disk: ReturnType<typeof memoryDisk>): Promise<ScoutDoc> {
  const current = await disk.readDoc(SCOUT_DOC_KEY);
  return current.value as ScoutDoc;
}

describe("scheduled scout turn", () => {
  it("settles quietly while the setting is off, and does not read or finish a night the store cannot save", async () => {
    const disk = memoryDisk();
    let reads = 0;
    const readText = async () => {
      reads += 1;
      return "";
    };
    expect(await runScheduledScout({ cwd, disk, readText })).toEqual({ kind: "quiet" });
    expect(reads).toBe(0);

    await changeScoutDoc(disk, (doc) => ({ ...doc, settings: on }));
    expect(
      await runScheduledScout({
        cwd,
        disk,
        readText: async () => {
          throw new Error("timed out");
        },
      }),
    ).toEqual({ kind: "retry" });
    expect((await saved(disk)).rows).toEqual([]);

    const dead: LocalHubDisk = {
      async read() {
        return null;
      },
      async readDoc() {
        throw new Error("timed out");
      },
      async write() {
        return null;
      },
    };
    expect(await runScheduledScout({ cwd, disk: dead, readText })).toEqual({ kind: "retry" });
    expect(disk.docs.has(SCOUT_DOC_KEY)).toBe(true);
  });

  it("writes capped drafts from the sources table and the watch file, and does not write them again", async () => {
    const disk = memoryDisk();
    await changeScoutDoc(disk, (doc) => ({ ...doc, settings: on }));
    const readText = reader(files);
    expect(await runScheduledScout({ cwd, disk, readText, now: 50 })).toEqual({ kind: "quiet" });
    const first = await saved(disk);
    expect(first.rows.map((row) => [row.title, row.status, row.securityPark, row.branch])).toEqual([
      ["Show the queue", "queued", false, ""],
      ["Auth for the desk", "parked", true, ""],
    ]);
    expect(first.rows.every((row) => row.briefPath === `overnight-scout/briefs/${row.id}.md` && row.projectId === "my-crew")).toBe(
      true,
    );
    expect(first.briefs[first.rows[0]!.id]).toContain("Source: firstmate (MIT).");
    expect(JSON.stringify(first)).not.toContain(cwd);
    expect(JSON.stringify(first)).not.toContain("invent a product");
    expect([...disk.docs.keys()]).toEqual([SCOUT_DOC_KEY]);

    expect(await runScheduledScout({ cwd, disk, readText, now: 80 })).toEqual({ kind: "quiet" });
    const second = await saved(disk);
    expect(second.rows.map((row) => row.title)).toEqual(["Show the queue", "Auth for the desk", "Board notes"]);
    expect(second.rows[1]?.status).toBe("parked");
    expect(second.rows[0]?.createdAt).toBe(50);
    expect(await runScheduledScout({ cwd, disk, readText, now: 90 })).toEqual({ kind: "quiet" });
    expect((await saved(disk)).rows).toEqual(second.rows);
  });

  it("treats a missing file as an empty night and a bad read as unfinished", async () => {
    const disk = memoryDisk();
    await changeScoutDoc(disk, (doc) => ({ ...doc, settings: on }));
    expect(
      await runScheduledScout({
        cwd,
        disk,
        readText: reader({}),
        now: 50,
      }),
    ).toEqual({ kind: "quiet" });
    expect((await saved(disk)).rows).toEqual([]);

    expect(
      await runScheduledScout({
        cwd,
        disk,
        readText: reader({ [`${cwd}/docs/hivra/SOURCES.md`]: SOURCES }),
        now: 50,
      }),
    ).toEqual({ kind: "quiet" });
    expect((await saved(disk)).rows).toEqual([]);

    expect(
      await runScheduledScout({
        cwd,
        disk,
        readText: reader({
          [`${cwd}/docs/hivra/SOURCES.md`]: new Error("File is too large to edit"),
          [`${folder}/watch.md`]: watch,
        }),
        now: 50,
      }),
    ).toEqual({ kind: "retry" });
    expect((await saved(disk)).rows).toEqual([]);

    expect(
      await runScheduledScout({
        cwd: "relative/crew",
        disk,
        readText: reader(files),
        now: 50,
      }),
    ).toEqual({ kind: "quiet" });
    expect((await saved(disk)).rows).toEqual([]);
  });

  it("keeps a row the other window wrote, and writes nothing if the setting was turned off", async () => {
    const disk = memoryDisk();
    await changeScoutDoc(disk, (doc) => ({ ...doc, settings: on }));
    const keptId = draftId("kept", "Already here");
    const kept: ProgrammeRow = {
      id: keptId,
      wp: "",
      title: "Already here",
      briefPath: briefRelativePath(keptId),
      branch: "",
      status: "parked",
      securityPark: true,
      draft: true,
      priority: 0,
      notes: "security-park",
      projectId: "my-crew",
      createdAt: 1,
      updatedAt: 1,
    };
    let conflicted = false;
    const racing: LocalHubDisk = {
      read: (key) => disk.read(key),
      readDoc: (key) => disk.readDoc(key),
      write: async (key, value, rev) => {
        if (!conflicted && key === SCOUT_DOC_KEY) {
          conflicted = true;
          const current = await disk.readDoc(key);
          const doc = current.value as ScoutDoc;
          await disk.write(key, { ...doc, rows: [kept], briefs: { [keptId]: "Keep this brief.\n" } }, rev);
          return null;
        }
        return disk.write(key, value, rev);
      },
    };
    expect(await runScheduledScout({ cwd, disk: racing, readText: reader(files), now: 50 })).toEqual({ kind: "quiet" });
    const merged = await saved(disk);
    expect(merged.rows.map((row) => row.title)).toEqual(["Already here", "Show the queue", "Auth for the desk"]);
    expect(merged.briefs[keptId]).toBe("Keep this brief.\n");
    expect(merged.rows[0]?.status).toBe("parked");

    const offDisk = memoryDisk();
    await changeScoutDoc(offDisk, (doc) => ({ ...doc, settings: on }));
    let seen = 0;
    const flipping: LocalHubDisk = {
      read: (key) => offDisk.read(key),
      readDoc: async (key) => {
        seen += 1;
        if (seen === 2) {
          const current = await offDisk.readDoc(key);
          const doc = current.value as ScoutDoc;
          await offDisk.write(key, { ...doc, settings: { ...doc.settings, enabled: false } }, current.rev);
        }
        return offDisk.readDoc(key);
      },
      write: (key, value, rev) => offDisk.write(key, value, rev),
    };
    expect(await runScheduledScout({ cwd, disk: flipping, readText: reader(files), now: 50 })).toEqual({ kind: "quiet" });
    expect((await offDisk.readDoc(SCOUT_DOC_KEY)).value).toMatchObject({ settings: { enabled: false }, rows: [] });
  });
});

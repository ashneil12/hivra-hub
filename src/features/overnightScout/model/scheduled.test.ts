import { describe, expect, it } from "vitest";
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { SCOUT_DEFAULTS } from "./settings";
import { runScheduledScout } from "./scheduled";
import { changeScoutDoc, SCOUT_DOC_KEY } from "./store";

describe("scheduled scout turn", () => {
  it("settles quietly while the setting is off, and does not finish a night the store cannot save", async () => {
    const disk = memoryDisk();
    expect(await runScheduledScout({ cwd: "/work/crew", disk })).toEqual({ kind: "quiet" });
    await changeScoutDoc(disk, (doc) => ({ ...doc, settings: { ...SCOUT_DEFAULTS, enabled: true } }));
    expect(await runScheduledScout({ cwd: "/work/crew", disk })).toEqual({ kind: "retry" });

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
    expect(await runScheduledScout({ cwd: "/work/crew", disk: dead })).toEqual({ kind: "retry" });
    expect(disk.docs.has(SCOUT_DOC_KEY)).toBe(true);
  });
});

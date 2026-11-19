import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScoutSettings, SCOUT_DEFAULTS, watchFolder } from "./settings";

describe("overnight scout settings", () => {
  it("is off, at 23:00, with 3 drafts, when nothing has been saved", () => {
    for (const value of [undefined, null, "", 0, [], "true", { enabled: "true" }]) {
      expect(parseScoutSettings(value)).toEqual(SCOUT_DEFAULTS);
    }
    expect(SCOUT_DEFAULTS.enabled).toBe(false);
  });

  it("turns on only for an exact true, and keeps a real time and a real cap", () => {
    expect(parseScoutSettings({ enabled: true, time: "22:15", maxDrafts: 0, watchFolder: "/work/notes" })).toEqual({
      enabled: true,
      time: "22:15",
      maxDrafts: 0,
      watchFolder: "/work/notes",
    });
    expect(parseScoutSettings({ enabled: true, time: "24:00", maxDrafts: 3.5 }).time).toBe("23:00");
    expect(parseScoutSettings({ enabled: true, time: "23:00:00", maxDrafts: -1 }).maxDrafts).toBe(3);
    expect(parseScoutSettings({ enabled: true, maxDrafts: 21 }).maxDrafts).toBe(3);
    expect(parseScoutSettings({ enabled: true, time: "09:00", maxDrafts: "3" }).maxDrafts).toBe(3);
  });

  it("refuses a folder bookmark that climbs out or carries a control character", () => {
    expect(watchFolder("..")).toBeNull();
    expect(watchFolder("/work/../secret")).toBeNull();
    expect(watchFolder("C:\\work\\..\\secret")).toBeNull();
    expect(watchFolder(" /work/notes ")).toBe("/work/notes");
    expect(watchFolder("")).toBeNull();
    expect(watchFolder("notes\0")).toBeNull();
    expect(watchFolder("notes\nmore")).toBeNull();
    expect(parseScoutSettings({ watchFolder: "../outside" }).watchFolder).toBeNull();
  });
});

describe("overnight scout text", () => {
  it("does not commit a private home path or a long dash", () => {
    const root = join(process.cwd(), "src/features/overnightScout");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(root);
    files.push(join(process.cwd(), "docs/hivra/work/WP-165-overnight-scout-drafts.md"));
    const home = `/${"Users"}/`;
    const windowsHome = `${"\\"}Users${"\\"}`;
    const banned = [home, windowsHome, String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const mark of banned) {
        expect(text.includes(mark), path).toBe(false);
      }
    }
  });
});

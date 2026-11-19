import { describe, expect, it } from "vitest";
import sensitivePathsFile from "./sensitivePaths.json";
import {
  SENSITIVE_PATHS_ADD_MORE,
  SENSITIVE_PATHS_LINE,
  SENSITIVE_PATH_GROUPS,
  parseSensitivePaths,
} from "./sensitivePaths";

const IDS = ["keys", "auth", "sandbox", "billing", "migrations", "ci", "installers"];

describe("the built-in sensitive paths", () => {
  it("parse from the shared JSON into the seven groups, in order", () => {
    expect(SENSITIVE_PATH_GROUPS.map((group) => group.id)).toEqual(IDS);
    expect(SENSITIVE_PATH_GROUPS).toEqual(sensitivePathsFile.groups);
    for (const group of SENSITIVE_PATH_GROUPS) expect(group.label.trim()).not.toBe("");
  });

  it("every pattern is a non-empty string with no spaces", () => {
    for (const group of SENSITIVE_PATH_GROUPS) {
      expect(group.patterns.length).toBeGreaterThan(0);
      for (const pattern of group.patterns) {
        expect(typeof pattern).toBe("string");
        expect(pattern.length).toBeGreaterThan(0);
        expect(pattern).not.toMatch(/\s/);
      }
    }
  });

  it("a well-formed shape parses as it is", () => {
    expect(parseSensitivePaths({ version: 1, groups: [{ id: "a", label: "A", patterns: ["**/x"] }] })).toEqual([
      { id: "a", label: "A", patterns: ["**/x"] },
    ]);
  });

  it("a malformed shape gives an empty list and never throws", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      "groups",
      3,
      [],
      {},
      { version: 2, groups: sensitivePathsFile.groups },
      { version: 1 },
      { version: 1, groups: "x" },
      { version: 1, groups: [null] },
      { version: 1, groups: [{ id: "keys", label: "Keys", patterns: "**/*.pem" }] },
      { version: 1, groups: [{ id: "keys", label: "Keys", patterns: [] }] },
      { version: 1, groups: [{ id: "keys", label: "Keys", patterns: [3] }] },
      { version: 1, groups: [{ id: "keys", label: "Keys", patterns: ["has space"] }] },
      { version: 1, groups: [{ id: "", label: "Keys", patterns: ["**/*.pem"] }] },
      { version: 1, groups: [{ id: "keys", patterns: ["**/*.pem"] }] },
    ];
    for (const value of malformed) {
      expect(() => parseSensitivePaths(value)).not.toThrow();
      expect(parseSensitivePaths(value), JSON.stringify(value)).toEqual([]);
    }
  });

  it("the line and the add-more sentence are exact and have no dashes", () => {
    expect(SENSITIVE_PATHS_LINE).toBe(
      "Changes to keys, permissions, the sandbox, billing, migrations, CI or installers always get the full checks.",
    );
    expect(SENSITIVE_PATHS_ADD_MORE).toBe("Add more paths to a project's protected list.");
    expect(SENSITIVE_PATHS_LINE).not.toMatch(/[—–]/);
    expect(SENSITIVE_PATHS_ADD_MORE).not.toMatch(/[—–]/);
  });
});

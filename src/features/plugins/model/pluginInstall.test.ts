import { describe, expect, it } from "vitest";
import {
  installedRows,
  pinField,
  readPending,
  readRegistry,
  sourceLine,
  updatePayload,
  type InstalledPlugin,
  type PluginSource,
} from "./pluginInstall";

const npm: PluginSource = { kind: "npm", location: "demo-plugin", pin: "1.0.0" };
const git: PluginSource = {
  kind: "git",
  location: "https://example.com/demo.git",
  pin: "a".repeat(40),
  tag: "v1.0.0",
  path: "pkg",
};

function row(name: string, source: PluginSource = npm): InstalledPlugin {
  return {
    name,
    version: "1.0.0",
    source,
    installedAtMs: 1,
    enabled: { global: false, projects: [] },
  };
}

describe("readRegistry", () => {
  it("rejects a missing or wrongly shaped list", () => {
    for (const value of [undefined, null, "plugins", [], { plugins: null }, { plugins: [] }]) {
      expect(() => readRegistry(value)).toThrow(/couldn't be read/);
    }
  });

  it("keeps an empty install as empty", () => {
    expect(installedRows(readRegistry({ version: 1, plugins: {} }))).toEqual([]);
  });

  it("drops a row with no name and sorts the rest", () => {
    const rows = installedRows(
      readRegistry({
        plugins: {
          zeta: row("zeta"),
          alpha: row("alpha"),
          broken: { source: npm },
        },
      }),
    );
    expect(rows.map((item) => item.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("readPending", () => {
  it("treats a broken waiting list as nothing waiting", () => {
    expect(readPending(undefined)).toEqual([]);
    expect(readPending({ id: "x" })).toEqual([]);
    expect(readPending([{ name: "demo" }, null, { id: "a", name: "demo" }])).toEqual([
      { id: "a", name: "demo" },
    ]);
  });
});

describe("updatePayload", () => {
  it("keeps the package and asks for the exact version", () => {
    expect(updatePayload(npm, " 1.2.3 ")).toEqual({
      kind: "npm",
      package: "demo-plugin",
      version: "1.2.3",
    });
    expect(updatePayload({ ...npm, registry: "https://npm.example" }, "1.2.3")).toEqual({
      kind: "npm",
      package: "demo-plugin",
      version: "1.2.3",
      registry: "https://npm.example",
    });
  });

  it("sends a full commit id as a commit and anything else as a tag", () => {
    const sha = "ab".repeat(20);
    expect(updatePayload(git, sha).kind === "git" && updatePayload(git, sha)).toMatchObject({
      commit: sha,
      url: git.location,
      path: "pkg",
    });
    expect(updatePayload(git, "v2.0.0")).toMatchObject({ tag: "v2.0.0", path: "pkg" });
    expect(updatePayload(git, "main")).toMatchObject({ tag: "main" });
    expect(updatePayload(git, "abc")).not.toMatchObject({ commit: "abc" });
  });

  it("sends a local folder as a full path", () => {
    expect(updatePayload({ kind: "local", location: "/old" }, " /tmp/next ")).toEqual({
      kind: "local",
      path: "/tmp/next",
    });
  });

  it("names the field the person fills in", () => {
    expect(pinField("npm").empty).toBe("Give an exact version.");
    expect(pinField("git").label).toBe("Commit or tag");
    expect(pinField("local").empty).toBe("Give the folder's full path.");
  });
});

describe("sourceLine", () => {
  it("says where a plugin came from, and falls back when the source is missing", () => {
    expect(sourceLine(npm)).toBe("demo-plugin@1.0.0");
    expect(sourceLine(git)).toContain("pkg");
    expect(sourceLine(git)).toContain("v1.0.0");
    expect(sourceLine(null)).toBe("Unknown source");
    expect(sourceLine({ kind: "local", location: "/tmp/solo" })).toBe("/tmp/solo");
  });
});

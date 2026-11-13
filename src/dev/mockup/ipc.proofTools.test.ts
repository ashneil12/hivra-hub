// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readProofToolList } from "../../features/proofTools/model/proofTools";
import { readSwitches } from "../../features/proofTools/model/proofToolsSettings";
import { mockupIpc } from "./ipc";

const STALE = "That changed in another window. Look again, then set it.";

describe("the mockup's proof tools", () => {
  beforeEach(() => localStorage.clear());

  it("answers a list the app's own reader takes: fast-check and Playwright installed, StrykerJS proposed", () => {
    const list = readProofToolList(mockupIpc("proof_tools_list", { folder: "/Users/example/Projects/shop-app" }));
    expect(list?.revision).toBe(0);
    expect(list?.tools.map((tool) => [tool.id, tool.installed, tool.status, tool.off])).toEqual([
      ["fast-check", true, "open", false],
      ["stryker", false, "proposed", false],
      ["playwright", true, "open", false],
    ]);
  });

  it("switches a tool off on the revision it was read at, and refuses an old revision", () => {
    const folder = "/Users/example/Projects/shop-app";
    const answer = readSwitches(mockupIpc("proof_tools_set", { folder, toolId: "fast-check", on: false, expectedRevision: 0 }));
    expect(answer).toEqual({ off: ["fast-check"], revision: 1 });
    expect(readProofToolList(mockupIpc("proof_tools_list", { folder }))?.tools[0]).toMatchObject({ id: "fast-check", off: true });
    expect(() => mockupIpc("proof_tools_set", { folder, toolId: "playwright", on: false, expectedRevision: 0 })).toThrow(STALE);
    expect(readSwitches(mockupIpc("proof_tools_set", { folder, toolId: "fast-check", on: true, expectedRevision: 1 }))).toEqual({ off: [], revision: 2 });
    // Another project is not touched.
    expect(readProofToolList(mockupIpc("proof_tools_list", { folder: "/Users/example/Projects/recipes" }))?.revision).toBe(0);
  });
});

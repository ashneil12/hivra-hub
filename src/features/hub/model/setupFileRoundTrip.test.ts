// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { addConnectors, allConnectors } from "./connectors";
import { exportSetup, parseSetup, restoreSetup } from "./setupFile";
import { approvedPermissions, buildPreview, keepPage, keptPages, resetPagesForTest } from "../../pages/model/pages";

beforeEach(() => resetPagesForTest());

it("export carries projects, services and kept Pages, and never a key or account", () => {
  addConnectors([{ id: "c-linear", name: "Linear", projectId: "hivra" }]);
  keepPage(buildPreview("sign-ups this week", "Hivra lead", 1, "hivra"));
  const text = exportSetup();
  const file = parseSetup(text);
  expect(file.connectors?.some((c) => c.name === "Linear")).toBe(true);
  expect(file.pages?.length).toBe(1);
  expect(text).not.toMatch(/"(secret|account|signedIn)"/);
});

it("import brings the Pages back without their permissions", () => {
  const page = { ...buildPreview("bespoke key page", "Hivra lead", 2, "hivra") };
  keepPage(page);
  const text = exportSetup();
  resetPagesForTest();
  expect(keptPages("hivra")).toHaveLength(0);
  restoreSetup(text);
  expect(keptPages("hivra").map((p) => p.id)).toContain(page.id);
  expect(approvedPermissions(page.id)).toEqual([]);
  expect(allConnectors().length).toBeGreaterThan(0);
});

it("a file that isn't a setup export is turned down in plain words", () => {
  expect(() => parseSetup('{"hello":1}')).toThrow("That file isn't a Monocode setup export.");
});

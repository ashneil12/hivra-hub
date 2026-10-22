// @vitest-environment happy-dom
// A v1 setup file (the single .json from before Phase 5) still imports, through the v2 preview and restore.
import { beforeEach, expect, it } from "vitest";
import { allConnectors } from "./connectors";
import { parseSetup } from "./setupFile";
import { approvedPermissions, buildPreview, keptPages, resetPagesForTest } from "../../pages/model/pages";
import { migrateV1 } from "../../portable/model/setupDoc";
import { applyImport, defaultChoices, planImport } from "../../portable/model/importPlan";

beforeEach(() => {
  localStorage.clear();
  resetPagesForTest();
});

async function importV1(file: unknown) {
  const pending = { name: "monocode-setup.json", path: null, doc: migrateV1(parseSetup(JSON.stringify(file))), inspection: null, fromV1: true, folders: {}, skillsHere: {} };
  const plan = planImport(pending);
  return applyImport(pending, plan, defaultChoices(plan));
}

it("a v1 file's Pages come back without their permissions, and its services as sign-ins to do", async () => {
  const page = { ...buildPreview("bespoke key page", "Hivra lead", 2, "hivra"), permissions: ["tasks.read"] };
  const summary = await importV1({ format: "monocode-hub-setup", version: 1, projects: [], connectors: [{ id: "c-linear", name: "Linear", projectId: "hivra" }], pages: [page] });
  expect(keptPages("hivra").map((p) => p.id)).toContain(page.id);
  expect(approvedPermissions(page.id)).toEqual([]);
  expect(allConnectors()).toEqual([{ id: "c-linear", name: "Linear", projectId: "hivra", signedIn: false }]);
  expect(summary.lines.join(" ")).toContain("sign in to each again");
});

it("a file that isn't a setup export is turned down in plain words", () => {
  expect(() => parseSetup('{"hello":1}')).toThrow("That file isn't a Monocode setup export.");
  expect(() => parseSetup("not json")).toThrow("That file isn't a Monocode setup export.");
});

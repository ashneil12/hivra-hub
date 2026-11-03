// WP-04 review: the import takes what the real Ash OS answered, not only shapes this repo invented. The fixture is the
// projects and mono_projects answers of the real ashos.hub.Hub (invented content), as the retired contract test had them.
import { expect, it } from "vitest";
import shapes from "./fixtures/ash-os-import-shapes.json";
import { LocalHub, memoryDisk } from "./localHub";
import { runAshOsImport, type ImportFound } from "./ashOsImport";

it("imports the real service's projects and Monos per project as they were", async () => {
  // What ash_os_import.rs hands over: each answer's list (`projects`, `memberships`).
  const found: ImportFound = {
    state: "found",
    projects: shapes.projects.projects,
    memberships: shapes.mono_projects.memberships,
    pages: [],
  };
  const hub = new LocalHub(memoryDisk());
  const decision = await runAshOsImport(hub, { fetch: async () => found, ask: async () => "import" });
  expect(decision).toMatchObject({ decided: "imported", added: { projects: 4, memberships: 2, pages: 0 } });
  const { projects } = await hub.projects();
  expect(projects.map((p) => [p.id, p.name, p.shortName, p.iconShape, p.folder, p.status])).toEqual([
    ["ash", "Harness & how I work", "Harness", "folder", null, "active"],
    ["hivra", "Hivra", "Hivra", "folder", "/tmp/hub-test/hivra", "active"],
    ["nibbii", "Nibbii", "Nibbii", "folder", "/tmp/hub-test/nibbii", "active"],
    ["vg-game", "EXO", "EXO", "folder", "/tmp/hub-test/vg-game", "active"],
  ]);
  // Ash OS's own bookkeeping (workOwner, needsCount) stays behind.
  expect(projects.some((p) => "workOwner" in p || "needsCount" in p)).toBe(false);
  const { byProject, memberships } = await hub.monoProjects();
  expect(byProject).toEqual({ hivra: ["chief-of-staff", "hivra-lead"] });
  expect(memberships.find((m) => m.monoId === "hivra-lead")).toMatchObject({ role: "lead", addedAt: "2026-10-15T02:32:48.622547Z" });
  // The strip reads them in the same order.
  expect((await hub.layout()).strip.map((p) => p.id)).toEqual(["ash", "hivra", "nibbii", "vg-game"]);
});

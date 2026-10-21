// @vitest-environment happy-dom
// Review 21 Oct: a full export imported into a fresh install brings the whole team in. The four team Monos already
// seated here (with the shipped souls, no memory) take the export's souls and memory; a Mono edited here keeps its
// own; Monos the fresh install doesn't have wait for one OK, as every file's Monos do; the user's name comes with it;
// and the install stops reading as fresh ("imported").
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const TEAM = ["chief-of-staff", "projects-manager", "frank", "alfred"];

async function app() {
  vi.resetModules();
  return {
    mono: await import("../../monos/model/mono"),
    builtIn: await import("../../hub/model/builtInMonos"),
    hubTeam: await import("../../hub/model/hubTeam"),
    pack: await import("../../hub/model/teamPack"),
    souls: await import("../../hub/model/teamSouls"),
    setupSouls: await import("../../hub/model/setupSouls"),
    name: await import("../../hub/model/userName"),
    doc: await import("./setupDoc"),
    plan: await import("./importPlan"),
  };
}

function disk() {
  const files = new Map<string, string>();
  return {
    files,
    read: async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null }),
    write: async (id: string, path: AgentFilePath, text: string) => void files.set(`${id}/${path}`, text),
  };
}

beforeEach(() => localStorage.clear());

async function ashExport() {
  // Ash's install: a team already there (it reads as his, read only), his own souls and memory.
  const a = await app();
  const names = ["Chief of Staff", "Projects Manager", "frank", "Alfred"];
  TEAM.forEach((id, i) => a.mono.addMono({ id, name: names[i], mascot: "robot", color: "x", projects: [], engine: "claude" }));
  expect(a.pack.knownTeamPack()).toBe("ash");
  a.mono.addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "crab", color: "x", projects: [] });
  const monoFiles = Object.fromEntries([
    ...TEAM.map((id) => [id, { "SOUL.md": a.souls.TEAM_SOULS[id], "MEMORY.md": `- 2026-10-01 · what ${id} knows` }]),
    ["hivra-lead", { "SOUL.md": "# Hivra lead\n" }],
  ]);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles, workspace: false }));
  expect(JSON.parse(files["setup/setup.json"]).settings["monocode:hub-user-name"]).toBe("Ash"); // his name travels
  return files;
}

it("a fresh install that imports Ash's export gets his team: souls, memory, roster, name, and is no longer fresh", async () => {
  const files = await ashExport();
  localStorage.clear();
  const b = await app();
  b.builtIn.ensureBuiltInMonos();
  const here = disk();
  await b.hubTeam.seedTeamFiles(here.read, here.write);
  expect(b.pack.knownTeamPack()).toBe("plain");
  expect(b.name.userName()).toBeUndefined();
  for (const id of TEAM) expect(here.files.get(`${id}/SOUL.md`)).toBe(b.souls.PLAIN_SOULS[id]);
  // The user edited frank's soul before importing: that stays theirs.
  here.files.set("frank/SOUL.md", "# Soul\n\nMy own frank.\n");

  const pending = { name: "ash", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  expect(plan.monos.filter((m) => m.state === "here").map((m) => m.mono.id).sort()).toEqual([...TEAM].sort());
  const summary = await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { agentFiles: { read: here.read, write: here.write } });

  for (const id of TEAM.filter((id) => id !== "frank")) {
    expect(here.files.get(`${id}/SOUL.md`), id).toBe(b.souls.TEAM_SOULS[id]);
    expect(here.files.get(`${id}/MEMORY.md`), id).toBe(`- 2026-10-01 · what ${id} knows`);
  }
  expect(here.files.get("frank/SOUL.md")).toBe("# Soul\n\nMy own frank.\n");
  expect(here.files.get("frank/MEMORY.md")).toBe("- 2026-10-01 · what frank knows");
  expect(b.mono.listMonos().map((m) => m.name)).toEqual(["Chief of Staff", "Projects Manager", "frank", "Alfred"]);
  // A Mono this install doesn't have waits for one OK, like any file's.
  expect(b.setupSouls.waitingSouls().map((w) => w.monoId)).toEqual(["hivra-lead"]);
  expect(summary.lines.join(" ")).toContain("1 Mono waiting for your OK");
  expect(b.pack.knownTeamPack()).toBe("imported");
  expect(b.name.userName()).toBe("Ash");
  expect(b.name.forUser("Tell Ash, then ask him.")).toBe("Tell Ash, then ask him.");
  // Imported, not fresh: a team Mono added later gets the shipped soul, never anything personal.
  expect(b.pack.teamSouls()).toBe(b.souls.PLAIN_SOULS);
});

it("Ash's own install importing his export keeps everything it has: nothing seeded is replaced, the pack stays his", async () => {
  const files = await ashExport();
  const b = await app();
  const here = disk();
  for (const id of TEAM) here.files.set(`${id}/SOUL.md`, b.souls.TEAM_SOULS[id] + "\n- his own line\n");
  const pending = { name: "ash", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { agentFiles: { read: here.read, write: here.write } });
  for (const id of TEAM) expect(here.files.get(`${id}/SOUL.md`)).toBe(b.souls.TEAM_SOULS[id] + "\n- his own line\n");
  expect(b.pack.knownTeamPack()).toBe("ash");
  expect(localStorage.getItem("monocode:hub-team-pack")).toBeNull();
});

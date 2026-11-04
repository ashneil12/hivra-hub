// @vitest-environment happy-dom
// A full export imported into a fresh install brings the Monos that are in the file. Nothing is seated by
// ensureBuiltInMonos. A Mono already here keeps a soul Ash edited; a missing memory file is filled. New Monos wait
// for one OK, then their souls and memory land. The user's name comes with the export.
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const TEAM = ["ada", "bo", "ed", "cam"] as const;
const NAMES: Record<(typeof TEAM)[number], string> = { ada: "Ada", bo: "Bo", ed: "Ed", cam: "Cam" };
const SOULS: Record<(typeof TEAM)[number], string> = {
  ada: "# Ada\n\n## Role\nKeeps the day\n",
  bo: "# Bo\n\n## Role\nKeeps the work\n",
  ed: "# Ed\n\n## Role\nKeeps the notes\n",
  cam: "# Cam\n\n## Role\nKeeps the plan\n",
};

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
  // Ash's install: ordinary Monos he added, with their own souls and memory, plus a project lead.
  const a = await app();
  for (const id of TEAM) a.mono.addMono({ id, name: NAMES[id], mascot: "robot", color: "x", projects: [], engine: "claude" });
  expect(a.pack.knownTeamPack()).toBe("ash");
  a.mono.addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "crab", color: "x", projects: [] });
  const monoFiles = Object.fromEntries([
    ...TEAM.map((id) => [id, { "SOUL.md": SOULS[id], "MEMORY.md": `- 2026-10-01 · what ${id} knows` }]),
    ["hivra-lead", { "SOUL.md": "# Hivra lead\n" }],
  ]);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles, workspace: false }));
  expect(JSON.parse(files["setup/setup.json"]).settings["monocode:hub-user-name"]).toBe("Ash");
  return files;
}

it("a fresh install that imports Ash's export gets the Monos in the file, and does not clobber a soul he already edited", async () => {
  const files = await ashExport();
  localStorage.clear();
  const b = await app();
  const here = disk();
  expect(b.builtIn.ensureBuiltInMonos()).toBe(0);
  expect(b.mono.listMonos()).toEqual([]);
  await b.hubTeam.seedTeamFiles(here.read, here.write);
  expect(b.pack.knownTeamPack()).toBe("plain");
  expect(b.name.userName()).toBeUndefined();
  for (const id of TEAM) expect(here.files.has(`${id}/SOUL.md`), id).toBe(false);

  // Ed is already here, and Ash edited that soul. The export must not replace it; a missing memory file is filled.
  b.mono.addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [], engine: "claude" });
  here.files.set("ed/SOUL.md", "# Soul\n\nMy own ed.\n");

  const pending = { name: "ash", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  expect(plan.monos.filter((m) => m.state === "here").map((m) => m.mono.id)).toEqual(["ed"]);
  expect(plan.monos.filter((m) => m.state === "new").map((m) => m.mono.id).sort()).toEqual(["ada", "bo", "cam", "hivra-lead"]);
  const summary = await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { agentFiles: { read: here.read, write: here.write } });

  expect(here.files.get("ed/SOUL.md")).toBe("# Soul\n\nMy own ed.\n");
  expect(here.files.get("ed/MEMORY.md")).toBe("- 2026-10-01 · what ed knows");
  const waiting = ["ada", "bo", "cam", "hivra-lead"];
  expect(b.setupSouls.waitingSouls().map((w) => w.monoId).sort()).toEqual([...waiting].sort());
  expect(summary.lines.join(" ")).toContain("4 Monos waiting for your OK");
  for (const id of waiting) expect(await b.setupSouls.seatWaitingSoul(id, here.write, undefined, here.read), id).toEqual([]);

  for (const id of TEAM.filter((id) => id !== "ed")) {
    expect(here.files.get(`${id}/SOUL.md`), id).toBe(SOULS[id]);
    expect(here.files.get(`${id}/MEMORY.md`), id).toBe(`- 2026-10-01 · what ${id} knows`);
  }
  expect(here.files.get("hivra-lead/SOUL.md")).toBe("# Hivra lead\n");
  expect(b.mono.listMonos().map((m) => m.name).sort()).toEqual(["Ada", "Bo", "Cam", "Ed", "Hivra lead"]);
  expect(b.name.userName()).toBe("Ash");
  expect(b.name.forUser("Tell Ash, then ask him.")).toBe("Tell Ash, then ask him.");
  // No shipped soul is filled in for a Mono added later.
  expect(b.souls.TEAM_SOULS).toEqual({});
  expect(b.souls.PLAIN_SOULS).toEqual({});
  expect(b.pack.teamSouls()).toEqual({});
  expect(localStorage.getItem("monocode:hub-team-pack")).toBeNull();
});

it("Ash's own install importing his export keeps everything it has: nothing already here is replaced, and a fresh install that imports nothing gets no team", async () => {
  const files = await ashExport();
  const b = await app();
  const here = disk();
  for (const id of TEAM) here.files.set(`${id}/SOUL.md`, SOULS[id] + "\n- his own line\n");
  const pending = { name: "ash", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  expect(plan.monos.filter((m) => TEAM.includes(m.mono.id as (typeof TEAM)[number])).every((m) => m.state === "here")).toBe(true);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { agentFiles: { read: here.read, write: here.write } });
  for (const id of TEAM) expect(here.files.get(`${id}/SOUL.md`), id).toBe(SOULS[id] + "\n- his own line\n");
  expect(b.pack.knownTeamPack()).toBe("ash");
  expect(localStorage.getItem("monocode:hub-team-pack")).toBeNull();

  localStorage.clear();
  const fresh = await app();
  expect(fresh.builtIn.ensureBuiltInMonos()).toBe(0);
  expect(fresh.mono.listMonos()).toEqual([]);
});

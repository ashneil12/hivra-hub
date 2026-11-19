// @vitest-environment happy-dom
// WP-182: engineFast, skills and commands travel with a setup. Import only adds.
// An offered skill that is not installed here is kept, and the preview says so.
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const tauri = vi.hoisted(() => ({
  files: null as Record<string, string> | null,
  findNames: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "portable_inspect") {
      return {
        format: "v2",
        v1: null,
        manifest: null,
        files: tauri.files ?? {},
        memory: [],
        workspace: null,
        memoryTarget: "",
      };
    }
    if (cmd === "portable_paths_exist") return {};
    if (cmd === "portable_project_folder_checks") return {};
    if (cmd === "portable_find_skills") {
      const names = Array.isArray(args.names) ? (args.names as string[]) : [];
      tauri.findNames = names;
      return names.map((name) => ({ name, path: name === "missing-skill" ? null : `/skills/${name}` }));
    }
    return {};
  },
}));

const PROJECTS = [
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/work/hivra" },
];

async function app() {
  vi.resetModules();
  const hub = await import("../../hub/model/hubData");
  hub.setHubDataSource(undefined);
  const src = Object.create(hub.hubData());
  src.listProjects = () => PROJECTS;
  hub.setHubDataSource(src);
  return {
    mono: await import("../../monos/model/mono"),
    souls: await import("../../hub/model/setupSouls"),
    doc: await import("./setupDoc"),
    plan: await import("./importPlan"),
  };
}

function folders() {
  const files = new Map<string, string>();
  return {
    read: async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null }),
    write: async (id: string, path: AgentFilePath, text: string) => void files.set(`${id}/${path}`, text),
  };
}

beforeEach(() => {
  localStorage.clear();
  tauri.files = null;
  tauri.findNames = [];
});

it("round-trips fast, skills and commands, and keeps an unknown skill with its note", async () => {
  const a = await app();
  a.mono.addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "x",
    projects: ["/work/hivra"],
    engine: "claude",
    engineModel: "claude:opus-fast",
    engineFast: true,
    skills: ["grill-me", "missing-skill"],
    commands: ["ship"],
  });
  a.mono.addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [] });

  const doc = a.doc.buildSetupDoc({ monoFiles: {}, workspace: false });
  const ada = doc.monos.find((mono) => mono.id === "ada");
  expect(ada?.engineFast).toBe(true);
  expect(ada?.offeredSkills).toEqual(["grill-me", "missing-skill"]);
  expect(ada?.skills).toEqual([]);
  expect(ada?.commands).toEqual(["ship"]);
  expect(doc.monos.find((mono) => mono.id === "ed")?.offeredSkills).toBeUndefined();
  expect(doc.monos.find((mono) => mono.id === "ed")?.engineFast).toBeUndefined();

  const files = a.doc.setupDocToFiles(doc);
  const adaJson = JSON.parse(files["setup/monos/ada/mono.json"]) as {
    skills: string[];
    offeredSkills: string[];
    commands: string[];
    engineFast: boolean;
  };
  // SOUL.md's skill list stays `skills`. The card's list is `offeredSkills`, so the two never clobber each other.
  expect(adaJson.skills).toEqual([]);
  expect(adaJson.offeredSkills).toEqual(["grill-me", "missing-skill"]);
  expect(adaJson.commands).toEqual(["ship"]);
  expect(adaJson.engineFast).toBe(true);
  localStorage.clear();

  const b = await app();
  const pending = {
    name: "x",
    path: null,
    doc: b.doc.setupDocFromFiles(files),
    inspection: null,
    fromV1: false,
    folders: {},
    skillsHere: { "grill-me": true, "missing-skill": false },
  };
  const plan = b.plan.planImport(pending);
  const planned = plan.monos.find((mono) => mono.mono.id === "ada");
  expect(planned?.offeredMissing).toEqual(["missing-skill"]);
  expect(planned?.mono.offeredSkills).toEqual(["grill-me", "missing-skill"]);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan));
  const disk = folders();
  for (const waiting of b.souls.waitingSouls()) await b.souls.seatWaitingSoul(waiting.monoId, disk.write, undefined, disk.read);
  expect(b.mono.findMono("ada")?.engineFast).toBe(true);
  expect(b.mono.findMono("ada")?.skills).toEqual(["grill-me", "missing-skill"]);
  expect(b.mono.findMono("ada")?.commands).toEqual(["ship"]);
  expect(b.mono.findMono("ed")?.skills).toBeUndefined();
  expect(b.mono.findMono("ed")?.engineFast).toBeUndefined();

  // Already set here: the file adds names and does not replace fast or drop a skill.
  localStorage.clear();
  const c = await app();
  c.mono.addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "x",
    projects: [],
    engineFast: false,
    skills: ["tdd"],
    commands: ["review"],
  });
  const again = { ...pending, doc: c.doc.setupDocFromFiles(files) };
  const againPlan = c.plan.planImport(again);
  const choices = c.plan.defaultChoices(againPlan);
  choices.replaceSouls.add("ada");
  await c.plan.applyImport(again, againPlan, choices);
  expect(c.mono.findMono("ada")?.engineFast).toBe(false);
  expect(c.mono.findMono("ada")?.skills).toEqual(["tdd", "grill-me", "missing-skill"]);
  expect(c.mono.findMono("ada")?.commands).toEqual(["review", "ship"]);
});

it("asks whether an offered skill is installed here, and the preview says when it is not", async () => {
  const a = await app();
  a.mono.addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "x",
    projects: ["/work/hivra"],
    engine: "claude",
    skills: ["grill-me", "missing-skill"],
    commands: ["ship"],
  });
  tauri.files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  const portable = await import("./portable");
  const pending = await portable.readImport("/tmp/hivra-export.tar.gz");
  expect(tauri.findNames).toEqual(expect.arrayContaining(["missing-skill"]));
  const planned = a.plan.planImport(pending).monos.find((mono) => mono.mono.id === "ada");
  expect(planned?.offeredMissing).toEqual(["missing-skill"]);
});

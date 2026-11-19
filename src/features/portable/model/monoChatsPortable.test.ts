// @vitest-environment happy-dom
// G1 (Dropwave wiring): a first mate's further chats (Mono.chats) and its own chat in each project (Mono.projectSessions,
// the Chief of Staff's per-project chats) travel with a setup, so the chats the workspace brings back under the same ids
// are its chats again and not plain ones. Import only adds: a project chat already here stays, and a chat another first
// mate holds here is never taken.
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: async () => ({}) }));

const PROJECTS = [
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/work/hivra" },
  { id: "vg-game", name: "VG", shortName: "VG", iconShape: "sparkles", folder: "/work/vg" },
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
});

/** Ada (the Chief of Staff) with a main chat, two further chats and a chat in each project; Ed with only his main chat. */
async function exported() {
  const a = await app();
  a.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: ["/work/hivra"], sessionId: "ada-main" });
  a.mono.addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [], sessionId: "ed-main" });
  expect(a.mono.saveMonoSideChat("ada", "side-2")).toBe(true);
  expect(a.mono.saveMonoSideChat("ada", "side-3")).toBe(true);
  expect(a.mono.saveMonoProjectSession("ada", "hivra", "cos-hivra")).toBe(true);
  expect(a.mono.saveMonoProjectSession("ada", "vg-game", "cos-vg")).toBe(true);
  const doc = a.doc.buildSetupDoc({ monoFiles: {}, workspace: true });
  return { doc, files: a.doc.setupDocToFiles(doc) };
}

function pendingOf(b: Awaited<ReturnType<typeof app>>, files: Record<string, string>) {
  return { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
}

it("writes a first mate's further chats and project chats into its mono.json", async () => {
  const { doc, files } = await exported();
  const ada = doc.monos.find((m) => m.id === "ada");
  expect(ada?.chats).toEqual(["side-2", "side-3"]);
  expect(ada?.projectSessions).toEqual({ hivra: "cos-hivra", "vg-game": "cos-vg" });
  const json = JSON.parse(files["setup/monos/ada/mono.json"]) as Record<string, unknown>;
  expect(json.chats).toEqual(["side-2", "side-3"]);
  expect(json.projectSessions).toEqual({ hivra: "cos-hivra", "vg-game": "cos-vg" });
  // A Mono with none carries none.
  const ed = JSON.parse(files["setup/monos/ed/mono.json"]) as Record<string, unknown>;
  expect(ed).not.toHaveProperty("chats");
  expect(ed).not.toHaveProperty("projectSessions");
});

it("brings them back on an empty copy once the first mate is OK'd", async () => {
  const { files } = await exported();
  localStorage.clear();
  const b = await app();
  const pending = pendingOf(b, files);
  const plan = b.plan.planImport(pending);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan));
  const disk = folders();
  for (const waiting of b.souls.waitingSouls()) await b.souls.seatWaitingSoul(waiting.monoId, disk.write, undefined, disk.read);
  expect(b.mono.findMono("ada")?.chats).toEqual(["side-2", "side-3"]);
  expect(b.mono.findMono("ada")?.projectSessions).toEqual({ hivra: "cos-hivra", "vg-game": "cos-vg" });
  expect(b.mono.isMonoSideChat("side-2")).toBe(true);
  expect(b.mono.monoSessionProject("cos-hivra")).toBe("hivra");
  expect(b.mono.monoForSession("cos-vg")?.id).toBe("ada");
  expect(b.mono.findMono("ed")?.chats).toBeUndefined();
  expect(b.mono.findMono("ed")?.projectSessions).toBeUndefined();
});

it("only adds to a first mate already here: its own project chat stays, and another's chat is never taken", async () => {
  const { files } = await exported();
  localStorage.clear();
  const c = await app();
  c.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [], sessionId: "here-main" });
  c.mono.addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [], sessionId: "ed-main" });
  expect(c.mono.saveMonoSideChat("ada", "here-side")).toBe(true);
  expect(c.mono.saveMonoProjectSession("ada", "hivra", "here-hivra")).toBe(true);
  // Here, Ed holds the chat the file names as Ada's third.
  expect(c.mono.saveMonoSideChat("ed", "side-3")).toBe(true);
  const pending = pendingOf(c, files);
  const plan = c.plan.planImport(pending);
  await c.plan.applyImport(pending, plan, c.plan.defaultChoices(plan));
  expect(c.mono.findMono("ada")?.sessionId).toBe("here-main");
  expect(c.mono.findMono("ada")?.chats).toEqual(["here-side", "side-2"]);
  expect(c.mono.findMono("ada")?.projectSessions).toEqual({ hivra: "here-hivra", "vg-game": "cos-vg" });
  expect(c.mono.findMono("ed")?.chats).toEqual(["side-3"]);
  // Imported again: nothing changes.
  const again = pendingOf(c, files);
  const againPlan = c.plan.planImport(again);
  await c.plan.applyImport(again, againPlan, c.plan.defaultChoices(againPlan));
  expect(c.mono.findMono("ada")?.chats).toEqual(["here-side", "side-2"]);
  expect(c.mono.findMono("ada")?.projectSessions).toEqual({ hivra: "here-hivra", "vg-game": "cos-vg" });
});

it("drops a hand-edited file's bad chat ids", async () => {
  const { files } = await exported();
  const json = JSON.parse(files["setup/monos/ada/mono.json"]) as Record<string, unknown>;
  json.chats = ["side-2", "../etc", 7, "side-2", ""];
  json.projectSessions = { hivra: "../x", "vg-game": "cos-vg", other: 4 };
  const edited = { ...files, "setup/monos/ada/mono.json": JSON.stringify(json) };
  localStorage.clear();
  const b = await app();
  const ada = b.doc.setupDocFromFiles(edited).monos.find((m) => m.id === "ada");
  expect(ada?.chats).toEqual(["side-2"]);
  expect(ada?.projectSessions).toEqual({ "vg-game": "cos-vg" });
});

// @vitest-environment happy-dom
// "bring my whole setup across" carries every Mono's memory. Settings > Export and
// import is left exactly as it opens (the Memory box starts ticked), exported, then imported into a fresh install:
// every Mono's MEMORY.md arrives once that Mono gets its OK. A fresh install seats nobody by itself.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const tauri = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  exported: null as Record<string, string> | null,
  memoryOnDisk: {} as Record<string, string>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    tauri.calls.push({ cmd, args });
    if (cmd === "portable_info") return { memoryRoot: "/Users/ash/agent-memory", dev: false, memory: [{ name: "ash", files: 3, bytes: 9_000, history: false, global: true }] };
    if (cmd === "portable_mono_files") {
      // What Rust does: each Mono's soul always; its MEMORY.md only when memory was asked for.
      const { monos, memory } = args as { monos: { id: string }[]; memory: boolean };
      return Object.fromEntries(monos.map((m) => [m.id, { "SOUL.md": `# ${m.id}\n`, ...(memory ? { "MEMORY.md": tauri.memoryOnDisk[m.id] } : {}) }]));
    }
    if (cmd === "portable_session_engines") return {};
    if (cmd === "portable_find_skills") return [];
    if (cmd === "portable_export") {
      const { request } = args as { request: { files: Record<string, string>; destination: string } };
      tauri.exported = request.files;
      return { path: request.destination, form: "archive", counts: {}, secretsRemoved: 0, files: 1, bytes: 1, notes: [] };
    }
    throw new Error(`unexpected ${cmd}`);
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/Users/ash/Desktop/export.tar.gz", open: async () => null }));
vi.mock("../../../platform/tauri/fs", () => ({ revealPath: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEAM = ["ada", "bo", "ed", "cam"];
const ALL = [...TEAM, "hivra-lead"];

beforeEach(() => {
  localStorage.clear();
  tauri.calls = [];
  tauri.exported = null;
  tauri.memoryOnDisk = Object.fromEntries(ALL.map((id) => [id, `- 2026-10-01 · what ${id} knows`]));
});

function disk() {
  const files = new Map<string, string>();
  return {
    files,
    read: async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null }),
    write: async (id: string, path: AgentFilePath, text: string) => void files.set(`${id}/${path}`, text),
  };
}

it("export left at its defaults carries every Mono's memory, and a fresh install gets every MEMORY.md", async () => {
  // Ash's install: the team and a Lead.
  vi.resetModules();
  const mono = await import("../../monos/model/mono");
  const names = ["Ada", "Bo", "Ed", "Cam"];
  TEAM.forEach((id, i) => mono.addMono({ id, name: names[i], mascot: "robot", color: "x", projects: [], engine: "claude" }));
  mono.addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "crab", color: "x", projects: [] });

  const { PortablePage } = await import("./PortablePage");
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(PortablePage)));
  // Nothing is touched: the Memory box is ticked as the page opens.
  expect(host.querySelector("[data-portable-choice=memory] [role=checkbox]")!.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("[data-portable-choice=mono-memory] [role=checkbox]")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => (host.querySelector("[data-portable-export]") as HTMLElement).click());
  await vi.waitFor(() => expect(tauri.exported).not.toBeNull());
  expect(tauri.calls.find((c) => c.cmd === "portable_mono_files")!.args.memory).toBe(true);
  const files = tauri.exported!;

  // A fresh install imports it with the preview's defaults.
  localStorage.clear();
  vi.resetModules();
  const builtIn = await import("../../hub/model/builtInMonos");
  const hubTeam = await import("../../hub/model/hubTeam");
  const doc = await import("../model/setupDoc");
  const plan = await import("../model/importPlan");
  const setupSouls = await import("../../hub/model/setupSouls");
  expect(builtIn.ensureBuiltInMonos()).toBe(0);
  expect((await import("../../monos/model/mono")).listMonos()).toEqual([]);
  const here = disk();
  await hubTeam.seedTeamFiles(here.read, here.write);
  for (const id of TEAM) expect(here.files.get(`${id}/MEMORY.md`) ?? "", id).not.toContain("what");

  const pending = { name: "export", path: null, doc: doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const p = plan.planImport(pending);
  expect(p.monoMemory).toBe(ALL.length);
  const choices = plan.defaultChoices(p);
  expect(choices.memory.on && choices.memory.monoMemory).toBe(true);
  await plan.applyImport(pending, p, choices, { agentFiles: { read: here.read, write: here.write } });
  // Every Mono in the file is new on a fresh install, so each waits for one OK, then its memory lands.
  expect(setupSouls.waitingSouls().map((w) => w.monoId).sort()).toEqual([...ALL].sort());
  for (const id of setupSouls.waitingSouls().map((w) => w.monoId))
    expect(await setupSouls.seatWaitingSoul(id, here.write, undefined, here.read), id).toEqual([]);

  for (const id of ALL) expect(here.files.get(`${id}/MEMORY.md`), id).toBe(`- 2026-10-01 · what ${id} knows`);
});

// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { addMono, listMonos } from "../../monos/model/mono";
import { seedTeamFiles } from "./hubTeam";
import { dismissWaitingSoul, roleOf, seatWaitingSoul, skillsOf, waitingSouls, writeSoulFiles } from "./setupSouls";
import { PLAIN_SOULS, TEAM_SOULS } from "./teamSouls";
import { parseSetup } from "./setupFile";
import { migrateV1 } from "../../portable/model/setupDoc";
import { applyImport, defaultChoices, planImport } from "../../portable/model/importPlan";

beforeEach(() => localStorage.clear());
const SOUL = "# Soul\n\n## Role\nKeeps the books\n\n## Skills\n- receipts\n- invoices\n";

async function importV1(file: unknown) {
  const pending = { name: "s.json", path: null, doc: migrateV1(parseSetup(JSON.stringify(file))), inspection: null, fromV1: true, folders: {}, skillsHere: {} };
  const plan = planImport(pending);
  await applyImport(pending, plan, defaultChoices(plan));
}

it("reads role and skills from a Mono's SOUL.md, and writes no built-in team souls", () => {
  expect(roleOf("Ledger", SOUL)).toBe("Keeps the books");
  expect(roleOf("ed", SOUL)).toBe("Keeps the books");
  expect(roleOf("mina", "# Soul\n")).toBe("");
  expect(skillsOf(SOUL)).toEqual(["receipts", "invoices"]);
  expect(TEAM_SOULS).toEqual({});
  expect(PLAIN_SOULS).toEqual({});
});

it("import never seats a Mono: it waits for Ash's OK, and OK seats it and writes its soul", async () => {
  await importV1({ format: "monocode-hub-setup", version: 1, projects: [], souls: [{ monoId: "ledger", name: "Ledger", role: "Keeps the books", rules: SOUL, memory: "- Ash files on Fridays", workflows: '[{"name":"Weekly receipts"}]', skills: ["receipts"] }] });
  expect(listMonos().some((m) => m.id === "ledger")).toBe(false);
  expect(waitingSouls().map((x) => x.monoId)).toEqual(["ledger"]);
  const write = vi.fn(async () => "h");
  await seatWaitingSoul("ledger", write, undefined, async () => ({ text: null }));
  expect(listMonos().some((m) => m.id === "ledger")).toBe(true);
  expect(write).toHaveBeenCalledWith("ledger", "SOUL.md", SOUL);
  expect(write).toHaveBeenCalledWith("ledger", "MEMORY.md", "- Ash files on Fridays");
  expect(waitingSouls()).toEqual([]);
});

it("bots in a file wait too, and Not now drops one without seating it", async () => {
  await importV1({ format: "monocode-hub-setup", version: 1, projects: [], bots: [{ id: "scout", name: "Scout", role: "", projectId: "x", team: "coding", skills: 0, mascot: "robot" }] });
  expect(waitingSouls().map((x) => x.monoId)).toEqual(["scout"]);
  dismissWaitingSoul("scout");
  expect(waitingSouls()).toEqual([]);
  expect(listMonos().some((m) => m.id === "scout")).toBe(false);
});

it("a file that can't be read is kept and reported, never overwritten as if it were missing", async () => {
  const disk = new Map<string, string>([["ledger/SOUL.md", "# mine"]]);
  const read = async (id: string, path: string) => {
    if (path === "SOUL.md") throw new Error("Permission denied");
    return { text: disk.get(`${id}/${path}`) ?? null };
  };
  const write = vi.fn(async (id: string, path: string, text: string) => void disk.set(`${id}/${path}`, text));
  const r = await writeSoulFiles("ledger", [["SOUL.md", "# theirs"], ["MEMORY.md", "- m"]], { read, write, replace: true });
  expect(disk.get("ledger/SOUL.md")).toBe("# mine");
  expect(r.written).toEqual(["MEMORY.md"]);
  expect(r.problems).toEqual([expect.stringMatching(/SOUL\.md.*Permission denied/)]);

  // Through an import into a Mono already here: the summary says which file and why.
  addMono({ id: "ledger", name: "Ledger", mascot: "robot", color: "x", projects: [] });
  const pending = { name: "s.json", path: null, doc: migrateV1(parseSetup(JSON.stringify({ format: "monocode-hub-setup", version: 1, projects: [], souls: [{ monoId: "ledger", name: "Ledger", role: "", rules: "# theirs", memory: "", workflows: "", skills: [] }] }))), inspection: null, fromV1: true, folders: {}, skillsHere: {} };
  const plan = planImport(pending);
  const summary = await applyImport(pending, plan, { ...defaultChoices(plan), replaceSouls: new Set(["ledger"]) }, { agentFiles: { read, write } });
  expect(disk.get("ledger/SOUL.md")).toBe("# mine");
  expect(summary.problems.join(" ")).toMatch(/Ledger.*SOUL\.md.*Permission denied/);
});

it("OK on a waiting Mono whose files can't be read keeps it waiting, so OK can try again", async () => {
  await importV1({ format: "monocode-hub-setup", version: 1, projects: [], souls: [{ monoId: "ledger", name: "Ledger", role: "", rules: SOUL, memory: "", workflows: "", skills: [] }] });
  const write = vi.fn(async () => "h");
  await seatWaitingSoul("ledger", write, undefined, async () => {
    throw new Error("Permission denied");
  });
  expect(write).not.toHaveBeenCalled();
  expect(waitingSouls().map((s) => s.monoId)).toEqual(["ledger"]);
  await seatWaitingSoul("ledger", write, undefined, async () => ({ text: null }));
  expect(write).toHaveBeenCalledWith("ledger", "SOUL.md", SOUL);
  expect(waitingSouls()).toEqual([]);
});

it("seating never overwrites files a Mono left here, unless asked", async () => {
  addMono({ id: "ledger", name: "Ledger", mascot: "robot", color: "x", projects: [] });
  const disk = new Map<string, string>([["ledger/SOUL.md", "# mine"], ["ledger/MEMORY.md", "  "]]);
  const read = async (id: string, path: string) => ({ text: disk.get(`${id}/${path}`) ?? null });
  const write = async (id: string, path: string, text: string) => void disk.set(`${id}/${path}`, text);
  const files: [import("../../monos/model/monoFiles").AgentFilePath, string][] = [["SOUL.md", "# theirs"], ["MEMORY.md", "- m"], ["memory/clients.md", "c"]];
  expect(await writeSoulFiles("ledger", files, { read, write })).toEqual({ written: ["MEMORY.md", "memory/clients.md"], kept: ["SOUL.md"], problems: [] });
  expect(disk.get("ledger/SOUL.md")).toBe("# mine");
  expect(await seedTeamFiles(read, write)).toEqual([]);
  expect(disk.get("ledger/SOUL.md")).toBe("# mine");
  await writeSoulFiles("ledger", files, { read, write, replace: true });
  expect(disk.get("ledger/SOUL.md")).toBe("# theirs");
});

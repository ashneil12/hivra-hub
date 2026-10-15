// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { addMono, listMonos } from "../../monos/model/mono";
import { collectSouls, dismissWaitingSoul, roleOf, seatWaitingSoul, skillsOf, waitingSouls } from "./setupSouls";
import { exportSetupWithSouls, parseSetup, restoreSetup } from "./setupFile";

beforeEach(() => localStorage.clear());
const SOUL = "# Soul\n\n## Role\nKeeps the books\n\n## Skills\n- receipts\n- invoices\n";
const files: Record<string, string> = { "SOUL.md": SOUL, "MEMORY.md": "- Ash files on Fridays", "habits.json": '[{"name":"Weekly receipts"}]' };
const read = vi.fn(async (_id: string, path: string) => ({ text: files[path] ?? null }));

it("reads role, rules, memory, workflows and skills from a Mono's files", () => {
  expect(roleOf("Ledger", SOUL)).toBe("Keeps the books");
  expect(roleOf("frank", SOUL)).toBe("Memory and checks");
  expect(skillsOf(SOUL)).toEqual(["receipts", "invoices"]);
});

it("export carries each seated Mono's soul", async () => {
  addMono({ id: "ledger", name: "Ledger", mascot: "robot", color: "x", projects: [] });
  const file = parseSetup(await exportSetupWithSouls(read));
  const soul = file.souls!.find((x) => x.monoId === "ledger")!;
  expect(soul).toMatchObject({ role: "Keeps the books", rules: SOUL, memory: "- Ash files on Fridays", skills: ["receipts", "invoices"] });
  expect(soul.workflows).toContain("Weekly receipts");
});

it("import never seats a Mono: it waits for Ash's OK, and OK seats it and writes its soul", async () => {
  const souls = await (async () => { addMono({ id: "ledger", name: "Ledger", mascot: "robot", color: "x", projects: [] }); return collectSouls(read); })();
  localStorage.clear();
  restoreSetup(JSON.stringify({ format: "monocode-hub-setup", version: 1, projects: [], souls }));
  expect(listMonos().some((m) => m.id === "ledger")).toBe(false);
  expect(waitingSouls().map((x) => x.monoId)).toEqual(["ledger"]);
  const write = vi.fn(async () => "h");
  await seatWaitingSoul("ledger", write);
  expect(listMonos().some((m) => m.id === "ledger")).toBe(true);
  expect(write).toHaveBeenCalledWith("ledger", "SOUL.md", SOUL);
  expect(write).toHaveBeenCalledWith("ledger", "MEMORY.md", "- Ash files on Fridays");
  expect(waitingSouls()).toEqual([]);
});

it("bots in a file wait too, and Not now drops one without seating it", () => {
  restoreSetup(JSON.stringify({ format: "monocode-hub-setup", version: 1, projects: [], bots: [{ id: "scout", name: "Scout", role: "", projectId: "x", team: "coding", skills: 0, mascot: "robot" }] }));
  expect(waitingSouls().map((x) => x.monoId)).toEqual(["scout"]);
  dismissWaitingSoul("scout");
  expect(waitingSouls()).toEqual([]);
  expect(listMonos().some((m) => m.id === "scout")).toBe(false);
});

it("from the Restore preview (ticked bots), souls with no bot row still come in as waiting", async () => {
  const { applySetup, parseSetup } = await import("./setupFile");
  applySetup(parseSetup(JSON.stringify({ format: "monocode-hub-setup", version: 1, projects: [], souls: [{ monoId: "ledger", name: "Ledger", role: "", rules: "", memory: "", workflows: "", skills: [] }] })), new Set());
  expect(waitingSouls().map((x) => x.monoId)).toEqual(["ledger"]);
});

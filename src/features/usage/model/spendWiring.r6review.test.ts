// @vitest-environment happy-dom
// Review r6 repro (WP-176 LOW3): the app's project folders reach the ledger's spend keys. The hub's projects load after
// the wiring runs (HubStore starts with no projects), so the list sent at wire time is empty and must be sent again.
import { expect, it, vi } from "vitest";

const calls: { cmd: string; args: unknown }[] = [];
const now = Date.parse("2026-11-10T15:00:00");
const hub = vi.hoisted(() => ({ projects: [] as { id: string; folder?: string }[] }));

vi.mock("../../hub/model/hubData", () => ({
  hubProjectList: () => hub.projects,
  hubProjectIdFor: (folder: string) => hub.projects.find((project) => project.folder === folder)?.id,
  hubProjectFolder: (id: string) => hub.projects.find((project) => project.id === id)?.folder,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { cwd?: string }) => {
    calls.push({ cmd, args });
    if (cmd === "spend_ledger_totals" || cmd === "spend_redo_links") return [];
    if (cmd === "spend_project_folder") return args.cwd;
    return undefined;
  }),
}));

import { wireSpendGate } from "./spendWiring";
import { admitSpendTurn, resetSpendGate, saveSpendLimit, setSpendClock, setSpendMonotonicClock } from "./spendGate";

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

it("sends the hub's projects to the ledger once they have loaded, not only the empty list from start-up", async () => {
  localStorage.clear();
  resetSpendGate();
  setSpendClock(() => now);
  let tick = 0;
  setSpendMonotonicClock(() => (tick += 60_000));
  wireSpendGate();
  await flush();
  const sent = () =>
    calls.filter((call) => call.cmd === "spend_set_project_folders").map((call) => (call.args as { projects: unknown[] }).projects);
  // Round 6 fix: no empty list is sent at wire time (it would clear the table), so nothing is sent yet.
  expect(sent().every((list) => list.length > 0)).toBe(true);
  // The hub's store answers: now there is a project. Several loader passes follow (each turn's admission reads the ledger).
  hub.projects = [{ id: "hivra", folder: "/work/monocode-hub" }];
  saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
  for (let pass = 0; pass < 3; pass += 1) {
    await admitSpendTurn({ sessionId: `s${pass}`, cwd: "/work/monocode-hub", harness: "claude", origin: "automated" });
    await flush();
  }
  expect(calls.filter((call) => call.cmd === "spend_ledger_totals").length).toBeGreaterThan(1);
  // Fails today: spend_set_project_folders ran once, at wire time, with [] (and that cleared the stored list).
  expect(sent().at(-1)).toEqual([{ id: "hivra", folder: "/work/monocode-hub" }]);
});

// @vitest-environment happy-dom
// The four project Leads, made on the Hub bundle's first run: roster entries, souls and files, identity, folder.
// No agent session is started and no model is called: the Mono files are written by a stand-in for the Rust
// `mono_load` / `mono_save` commands into a real temporary app-data folder, with the same layout (monos/<id>/...).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appData = fs.mkdtempSync(path.join(os.tmpdir(), "hub-leads-appdata-"));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { mono: string; path?: string; text?: string }) => {
    const dir = path.join(appData, "monos", args.mono);
    fs.mkdirSync(dir, { recursive: true });
    const memory = path.join(dir, "MEMORY.md");
    if (!fs.existsSync(memory)) fs.writeFileSync(memory, "");
    if (cmd === "mono_load") {
      const soulPath = path.join(dir, "SOUL.md");
      const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, "utf8") : null;
      return { id: args.mono, soul, soulHash: soul ?? "", memory: "", memoryHash: "", memoryPath: memory, topics: [], dir };
    }
    if (cmd === "mono_save") {
      fs.writeFileSync(path.join(dir, args.path!), args.text!);
      return args.text;
    }
    throw new Error(`unexpected ${cmd}`);
  }),
}));

import { listMonos, saveMonoName } from "../../monos/model/mono";
import { loadMonoFiles } from "../../monos/model/monoFiles";
import { ensureMonoSession } from "../../monos/model/monoWorkspace";
import { newSession } from "../../sessions/model/session";
import { ensureProjectLeads, LEADS, leadMcpArgs, leadSoul, leadWorkingFolder } from "./hubLeads";
import type { HubProject } from "./types";

// What the live service returned for the four projects on 15 Oct.
const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "ghost", folder: "/Users/ash/Projects/boxin game?/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/Projects/Hivra-public-canary" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/Users/ash/Projects/nibbii" },
  { id: "ash", name: "Harness", shortName: "Harness", iconShape: "gauge", folder: "/Users/ash/Projects/exo-cc-studio" },
];

beforeEach(() => localStorage.clear());

describe("the project Leads", () => {
  it("are made once each, named '<Project> lead', tied to their project's folder, and registered as the Lead in Ash OS", () => {
    const register = vi.fn(async () => undefined);
    const first = ensureProjectLeads(PROJECTS, register);
    expect(first.created).toEqual(["vg-game-lead", "hivra-lead", "nibbii-lead", "ash-lead"]);
    const roster = listMonos();
    expect(roster.map((m) => [m.id, m.name, m.projects])).toEqual([
      ["vg-game-lead", "EXO lead", ["/Users/ash/Projects/boxin game?/vg-game"]],
      ["hivra-lead", "Hivra lead", ["/Users/ash/Projects/Hivra-public-canary"]],
      ["nibbii-lead", "Nibbii lead", ["/Users/ash/Projects/nibbii"]],
      ["ash-lead", "Harness lead", ["/Users/ash/Projects/exo-cc-studio"]],
    ]);
    expect(new Set(roster.map((m) => m.mascot)).size).toBe(4);
    expect(register.mock.calls).toEqual([["vg-game-lead", "vg-game"], ["hivra-lead", "hivra"], ["nibbii-lead", "nibbii"], ["ash-lead", "ash"]]);
    // idempotent: nothing is made twice
    expect(ensureProjectLeads(PROJECTS).created).toEqual([]);
    expect(listMonos()).toHaveLength(4);
  });

  it("never overwrite what Ash changed, and re-tie a Lead that lost its folder", () => {
    ensureProjectLeads(PROJECTS);
    saveMonoName("hivra-lead", "Hivra boss");
    const moved = PROJECTS.map((p) => (p.id === "nibbii" ? { ...p, folder: "/Users/ash/Projects/nibbii-2" } : p));
    const again = ensureProjectLeads(moved);
    expect(again).toEqual({ created: [], tied: ["nibbii-lead"] });
    expect(listMonos().find((m) => m.id === "hivra-lead")?.name).toBe("Hivra boss");
    expect(listMonos().find((m) => m.id === "nibbii-lead")?.projects).toEqual(["/Users/ash/Projects/nibbii", "/Users/ash/Projects/nibbii-2"]);
  });

  it("start their chats in the project's folder (other Monos start at home)", async () => {
    ensureProjectLeads(PROJECTS);
    expect(leadWorkingFolder("vg-game-lead")).toBe("/Users/ash/Projects/boxin game?/vg-game");
    expect(leadWorkingFolder("someone-else")).toBeUndefined();
    const added: string[] = [];
    const session = await ensureMonoSession("vg-game-lead", {
      home: async () => "/Users/ash",
      load: async () => undefined,
      create: (cwd) => newSession("claude", cwd),
      add: (s) => added.push(s.cwd),
    });
    expect(session?.cwd).toBe("/Users/ash/Projects/boxin game?/vg-game");
    expect(session?.harness).toBe("claude");
    expect(listMonos().find((m) => m.id === "vg-game-lead")?.sessionId).toBe(session?.id);
  });

  it("talk to Ash OS as themselves: Ash's own ash-os entry, with ASH_MONO_ID and ASH_ROLE=lead", () => {
    const server = { command: "/opt/homebrew/bin/python3", args: ["/Users/ash/Projects/exo-cc-studio/bin/ash-os-mcp"], env: {} };
    const args = leadMcpArgs("hivra-lead", server);
    expect(args[0]).toBe("--mcp-config");
    expect(JSON.parse(args[1])).toEqual({
      mcpServers: { "ash-os": { command: "/opt/homebrew/bin/python3", args: ["/Users/ash/Projects/exo-cc-studio/bin/ash-os-mcp"], env: { ASH_MONO_ID: "hivra-lead", ASH_ROLE: "lead" } } },
    });
    expect(leadMcpArgs("not-a-lead", server)).toEqual([]);
    expect(leadMcpArgs("hivra-lead", null)).toEqual([]);
  });

  it("have a soul in Ash's words: orchestrator, full words to workers, sonnet workers, memory first, dumps verbatim, verify, Looks right only when critical, identity", () => {
    const soul = leadSoul(LEADS[0], "/Users/ash/Projects/boxin game?/vg-game");
    for (const phrase of [
      'the main agent is mainly an orchestrator',
      "pass Ash's own words and the full context, never a short brief",
      "`sonnet`",
      "so tokens aren't burned",
      "`ash_recall vg-game`",
      "`ash_dump`, in Ash's words verbatim",
      "Verify your own work: tests, an independent check, proof",
      'Ask Ash for "Looks right" only on very critical work',
      "ASH_MONO_ID=vg-game-lead, ASH_ROLE=lead",
      "working in /Users/ash/Projects/boxin game?/vg-game",
    ])
      expect(soul).toContain(phrase);
  });

  it("get their SOUL.md and MEMORY.md written into the app-data folder (monos/<id>/)", async () => {
    ensureProjectLeads(PROJECTS);
    for (const lead of LEADS) await loadMonoFiles(lead.id);
    for (const lead of LEADS) {
      const dir = path.join(appData, "monos", lead.id);
      const soul = fs.readFileSync(path.join(dir, "SOUL.md"), "utf8");
      expect(soul.startsWith("# Soul\n\n## Standing instructions\n")).toBe(true);
      expect(soul).toContain(`You are ${lead.name}`);
      expect(fs.existsSync(path.join(dir, "MEMORY.md"))).toBe(true);
    }
    // once written, the roster no longer carries the instructions: SOUL.md is the one place to edit
    expect(listMonos().every((m) => !m.instructions)).toBe(true);
    if (process.env.KEEP_LEADS_PROOF) {
      fs.writeFileSync(path.join(appData, "roster.json"), JSON.stringify(listMonos(), null, 2));
      console.log(`LEADS PROOF IN ${appData}`);
    }
  });
});

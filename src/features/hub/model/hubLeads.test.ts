// @vitest-environment happy-dom
// The four project Leads (EXO, Hivra, Nibbii, MonoCode Hub), made on the Hub bundle's first run: roster entries, souls and files, identity, folder.
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

import { addMono, listMonos, saveMonoName, removeMono } from "../../monos/model/mono";
import { loadMonoFiles } from "../../monos/model/monoFiles";
import { ensureMonoSession } from "../../monos/model/monoWorkspace";
import { newSession } from "../../sessions/model/session";
import { defaultSoul } from "../../monos/model/monoFiles";
import { completeLeadAdoption, ensureProjectLeads, leadFor, LEADS, leadSoul, leadWorkingFolder, reseedAdoptedLeadSoul } from "./hubLeads";
import { CREDENTIAL_DENIED_TOOLS, HUB_WORKTREE_DENIED_TOOLS, hubMcpArgs, OLD_MONO_COPY_DENIED_TOOLS } from "./hubMcp";
import type { HubProject } from "./types";

// The four projects (what the live service returned on 15 Oct, with the harness now the project `hub`, 19 Oct).
const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/Users/ash/Projects/boxin game?/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/Projects/Hivra-public-canary" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/Users/ash/Projects/nibbii" },
  { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge", folder: "/Users/ash/Projects/monocode-hub" },
];
/** The old harness project, now Ash's global memory: it must never get a Lead even if Ash OS still sends it. */
const GLOBAL_ASH: HubProject = { id: "ash", name: "Harness", shortName: "Harness", iconShape: "gauge", folder: "/Users/ash/Projects/exo-cc-studio" };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
});

describe("the project Leads", () => {
  it("are made once each, named '<Project> lead', tied to their project's folder, and registered as the Lead in Ash OS", () => {
    const register = vi.fn(async () => undefined);
    const first = ensureProjectLeads(PROJECTS, register);
    expect(first.created).toEqual(["vg-game-lead", "hivra-lead", "nibbii-lead", "hub-lead"]);
    const roster = listMonos();
    expect(roster.map((m) => [m.id, m.name, m.projects])).toEqual([
      ["vg-game-lead", "EXO lead", ["/Users/ash/Projects/boxin game?/vg-game"]],
      ["hivra-lead", "Hivra lead", ["/Users/ash/Projects/Hivra-public-canary"]],
      ["nibbii-lead", "Nibbii lead", ["/Users/ash/Projects/nibbii"]],
      ["hub-lead", "MonoCode Hub lead", ["/Users/ash/Projects/monocode-hub"]],
    ]);
    // Ash's looks from before 15 Oct, except Hivra's ghost, which is an orange dino.
    expect(roster.map((m) => [m.mascot, m.color])).toEqual([
      ["invader", "hsl(211 92% 62%)"],
      ["dino", "hsl(12 80% 58%)"],
      ["robot", "hsl(45 90% 55%)"],
      ["cat", "hsl(142 55% 50%)"],
    ]);
    expect(register.mock.calls).toEqual([["vg-game-lead", "vg-game"], ["hivra-lead", "hivra"], ["nibbii-lead", "nibbii"], ["hub-lead", "hub"]]);
    // idempotent: nothing is made twice
    expect(ensureProjectLeads(PROJECTS).created).toEqual([]);
    expect(listMonos()).toHaveLength(4);
  });

  it("never overwrite what Ash changed, and re-tie a Lead that lost its folder", () => {
    ensureProjectLeads(PROJECTS);
    saveMonoName("hivra-lead", "Hivra boss");
    const moved = PROJECTS.map((p) => (p.id === "nibbii" ? { ...p, folder: "/Users/ash/Projects/nibbii-2" } : p));
    const again = ensureProjectLeads(moved);
    expect(again).toEqual({ created: [], tied: ["nibbii-lead"], adopted: [] });
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

  it("talk to Ash OS as themselves: Ash's own ash-os entry, with ASH_MONO_ID, ASH_ROLE=lead and their chat", () => {
    ensureProjectLeads(PROJECTS);
    const server = { command: "/opt/homebrew/bin/python3", args: ["/Users/ash/Projects/exo-cc-studio/bin/ash-os-mcp"], env: {} };
    const lookups = {
      monoOf: (id: string) => (id === "chat-hivra" ? { id: "hivra-lead" } : undefined),
      habitRunMono: () => undefined,
      isLead: (id: string) => LEADS.some((lead) => lead.id === id),
    };
    const args = hubMcpArgs("chat-hivra", { ashOs: server, cli: null }, lookups);
    expect(args[0]).toBe("--mcp-config");
    expect(JSON.parse(args[1])).toEqual({
      mcpServers: {
        "ash-os": {
          command: "/opt/homebrew/bin/python3",
          args: ["/Users/ash/Projects/exo-cc-studio/bin/ash-os-mcp"],
          env: { ASH_MONO_ID: "hivra-lead", ASH_ROLE: "lead", ASH_CHAT: "chat-hivra" },
        },
      },
    });
    // Nothing but the fence round the Monos' home, which every hub chat has, and no Claude Code worktrees of its own.
    expect(hubMcpArgs("chat-hivra", { ashOs: null, cli: null }, lookups)).toEqual(["--disallowedTools", ["Edit(~/agent-memory/monos/**)", ...OLD_MONO_COPY_DENIED_TOOLS, ...CREDENTIAL_DENIED_TOOLS, ...HUB_WORKTREE_DENIED_TOOLS].join(",")]);
  });

  it("have a soul in Ash's words: orchestrator, full words to workers, sonnet workers, memory loads by itself, dumps verbatim, verify, Looks right only when critical, identity", () => {
    const soul = leadSoul(LEADS[0], "/Users/ash/Projects/boxin game?/vg-game");
    for (const phrase of [
      'the main agent is mainly an orchestrator',
      "pass Ash's own words and the full context, never a short brief",
      "`sonnet`",
      "so tokens aren't burned",
      "Your project's memory loads by itself",
      "`vg-game`'s current decisions and never-do rules and Ash's global ones (`ash`)",
      "You read and write only `vg-game` and `ash` (how Ash works), never another project's memory",
      "`ash_dump`, in Ash's words verbatim",
      "Verify your own work: tests, an independent check, proof",
      'Ask Ash for "Looks right" only on very critical work',
      "ASH_MONO_ID=vg-game-lead, ASH_ROLE=lead, ASH_PROJECT=vg-game",
      "working in /Users/ash/Projects/boxin game?/vg-game",
    ])
      expect(soul).toContain(phrase);
    expect(leadSoul(LEADS[3], "/x")).toMatch(/^You are MonoCode Hub lead, the lead for MonoCode Hub \(Ash OS project `hub`\), working in \/x\./);
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

it("does not recreate a project Lead that Ash deleted", () => {
  ensureProjectLeads(PROJECTS);
  removeMono("hivra-lead");
  const result = ensureProjectLeads(PROJECTS);
  expect(result.created).not.toContain("hivra-lead");
  expect(listMonos().some((m) => m.id === "hivra-lead")).toBe(false);
});

describe("the MonoCode Hub lead (the harness moved from `ash` to `hub`, 19 Oct)", () => {
  const HARNESS_LEAD = { id: "ash-lead", name: "Harness lead", mascot: "robot", color: "x", projects: ["/Users/ash/Projects/exo-cc-studio"], sessionId: "s-harness-chat" };

  it("the global `ash` memory never gets a Lead, whatever Ash OS sends", () => {
    const result = ensureProjectLeads([GLOBAL_ASH]);
    expect(result).toEqual({ created: [], tied: [], adopted: [] });
    expect(listMonos()).toEqual([]);
    ensureProjectLeads([...PROJECTS, GLOBAL_ASH]);
    expect(listMonos().map((m) => m.id)).toEqual(["vg-game-lead", "hivra-lead", "nibbii-lead", "hub-lead"]);
  });

  it("an existing Harness lead becomes it in place: same id and chat, new name, the hub's folder first, old binding dropped in Ash OS", async () => {
    addMono(HARNESS_LEAD);
    const register = vi.fn(async () => undefined);
    const unregister = vi.fn(async () => undefined);
    const result = ensureProjectLeads(PROJECTS, register, unregister);
    expect(result.adopted).toEqual(["ash-lead"]);
    expect(result.created).not.toContain("hub-lead");
    const lead = listMonos().find((m) => m.id === "ash-lead")!;
    expect(lead).toMatchObject({ name: "MonoCode Hub lead", sessionId: "s-harness-chat" });
    expect(lead.projects).toEqual(["/Users/ash/Projects/monocode-hub", "/Users/ash/Projects/exo-cc-studio"]);
    expect(listMonos().some((m) => m.id === "hub-lead")).toBe(false);
    expect(register).toHaveBeenCalledWith("ash-lead", "hub");
    expect(unregister.mock.calls).toEqual([["ash-lead", "ash"]]);
    expect(leadFor("ash-lead")?.projectId).toBe("hub");
    expect(leadWorkingFolder("ash-lead")).toBe("/Users/ash/Projects/monocode-hub");
    // it acts in Ash OS under the id Ash OS already knows
    const adopted = hubMcpArgs("s-harness-chat", { ashOs: { command: "x" }, cli: null }, {
      monoOf: (id) => listMonos().find((m) => m.sessionId === id),
      habitRunMono: () => undefined,
      isLead: (id) => !!leadFor(id),
    });
    expect(JSON.parse(adopted[1]).mcpServers["ash-os"].env).toEqual({ ASH_MONO_ID: "ash-lead", ASH_ROLE: "lead", ASH_CHAT: "s-harness-chat" });
    // with the app's own lookups (hubData.ts) it works on the project it now leads, `hub`, never the old `ash`; so do its workers
    const appLookups = {
      monoOf: (id: string) => listMonos().find((m) => m.sessionId === id),
      habitRunMono: () => undefined,
      isLead: (id: string) => !!leadFor(id),
      leadProject: (id: string) => leadFor(id)?.projectId,
    };
    for (const chat of ["s-harness-chat", "app-s-harness-chat-r1"])
      expect(JSON.parse(hubMcpArgs(chat, { ashOs: { command: "x" }, cli: null }, appLookups)[1]).mcpServers["ash-os"].env.ASH_PROJECT).toBe("hub");
    await completeLeadAdoption("ash-lead", async () => {});
    expect(unregister).toHaveBeenCalledTimes(1);
    // once its soul is written: a second launch changes nothing and makes no second Lead
    expect(ensureProjectLeads(PROJECTS, register, unregister)).toEqual({ created: [], tied: [], adopted: [] });
  });

  it("records the adoption only once its soul was written; a reseed that keeps failing leaves it to adopt again", async () => {
    addMono(HARNESS_LEAD);
    const unregister = vi.fn(async () => undefined);
    expect(ensureProjectLeads(PROJECTS, undefined, unregister).adopted).toEqual(["ash-lead"]);
    expect(localStorage.getItem("monocode:hub-lead-adopted")).toBeNull();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: number[] = [];
    const never = vi.fn(async () => {
      throw new Error("SOUL.md changed under us");
    });
    expect(await completeLeadAdoption("ash-lead", never, { wait: async (ms) => void waits.push(ms) })).toBe(false);
    expect(never).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([5_000, 30_000, 120_000]);
    expect(localStorage.getItem("monocode:hub-lead-adopted")).toBeNull();
    // Not recorded: the next pass adopts it again, and this time the reseed works.
    expect(ensureProjectLeads(PROJECTS, undefined, unregister).adopted).toEqual(["ash-lead"]);
    let tries = 0;
    const flaky = async () => {
      if (tries++ === 0) throw new Error("busy");
    };
    expect(await completeLeadAdoption("ash-lead", flaky, { wait: async () => {} })).toBe(true);
    error.mockRestore();
    expect(JSON.parse(localStorage.getItem("monocode:hub-lead-adopted")!)).toEqual(["ash-lead"]);
    expect(ensureProjectLeads(PROJECTS, undefined, unregister).adopted).toEqual([]);
  });

  it("keeps a name Ash gave the old seat", () => {
    addMono({ ...HARNESS_LEAD, name: "Harness boss" });
    ensureProjectLeads(PROJECTS);
    expect(listMonos().find((m) => m.id === "ash-lead")?.name).toBe("Harness boss");
  });

  it("is not made when Ash removed the Harness lead", () => {
    addMono(HARNESS_LEAD);
    removeMono("ash-lead");
    expect(ensureProjectLeads(PROJECTS).created).not.toContain("hub-lead");
    expect(listMonos().some((m) => m.id === "hub-lead" || m.id === "ash-lead")).toBe(false);
  });

  it("gets the new soul over the generated Harness-lead one, keeping the old text as a note; a soul Ash rewrote stays", async () => {
    const files = new Map<string, string>([["ash-lead/SOUL.md", defaultSoul("You are Harness lead, the lead for the harness (Ash OS project `ash`), working in /x.")]]);
    const read = async (id: string, p: string) => ({ text: files.get(`${id}/${p}`) ?? null, hash: files.get(`${id}/${p}`) ?? "" });
    const write = async (id: string, p: string, text: string) => void files.set(`${id}/${p}`, text);
    addMono(HARNESS_LEAD);
    ensureProjectLeads(PROJECTS);
    expect(await reseedAdoptedLeadSoul("ash-lead", "/Users/ash/Projects/monocode-hub", defaultSoul, read, write)).toBe(true);
    const soul = files.get("ash-lead/SOUL.md")!;
    expect(soul).toContain("You are MonoCode Hub lead, the lead for MonoCode Hub (Ash OS project `hub`), working in /Users/ash/Projects/monocode-hub.");
    for (const rule of ["Never edit the main checkout directly", "`npm run hub:dev`", "`npm run hub:check-all && npm run hub:build && npm run hub:ship`", "Start-ack", "ASH_MONO_ID=ash-lead"])
      expect(soul).toContain(rule);
    expect(files.get("ash-lead/memory/harness-lead-soul.md")).toContain("You are Harness lead");
    files.set("ash-lead/SOUL.md", "# Soul\n\nAsh's own words.\n");
    expect(await reseedAdoptedLeadSoul("ash-lead", "/x", defaultSoul, read, write)).toBe(false);
    expect(files.get("ash-lead/SOUL.md")).toBe("# Soul\n\nAsh's own words.\n");
    expect(await reseedAdoptedLeadSoul("hivra-lead", "/x", defaultSoul, read, write)).toBe(false);
  });

  it("only the hub Lead's soul carries the hub-from-inside-the-hub rules", () => {
    expect(leadSoul(LEADS[3], "/r")).toContain("Developing the hub from inside the hub");
    expect(leadSoul(LEADS[1], "/r")).not.toContain("Developing the hub from inside the hub");
    expect(leadSoul(LEADS[1], "/r")).toContain("Hold the line on RED");
  });
});

// @vitest-environment happy-dom
// The four project Leads (EXO, Hivra, Nibbii, MonoCode Hub), made on the Hub bundle's first run: roster entries, souls and files, identity, folder.
// No agent session is started and no model is called: the Mono files are written by a stand-in for the Rust
// `mono_load` / `mono_save` commands into a real temporary app-data folder, with the same layout (monos/<id>/...).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_HOOK_DENY_RULES, GUARD_STORE_DENY_RULES, HUB_DB_DENY_RULES, SECRET_ACTION_DENY_RULES } from "../../../integrations/harness/core/credentialGuard";

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
import { FIRST_MATE_CONTRACT } from "../../firstmate/model/contract";
import { completeLeadAdoption, ensureProjectLeads, leadFor, leadSoul, leadWorkingFolder, reseedAdoptedLeadSoul } from "./hubLeads";
import { CREDENTIAL_DENIED_TOOLS, HUB_WORKTREE_DENIED_TOOLS, hubChatIdentity, hubMcpArgs, OLD_MONO_COPY_DENIED_TOOLS } from "./hubMcp";
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
      ["hub-lead", "Hub lead", ["/Users/ash/Projects/monocode-hub"]],
    ]);
    // No project gets a private look. Each new lead takes the next free one, and none share.
    const looks = roster.map((m) => `${m.mascot}|${m.color}`);
    expect(looks.every((look) => look.split("|").every((part) => part.length > 0))).toBe(true);
    expect(new Set(looks).size).toBe(looks.length);
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

  it("know who they are in their own chat: the Lead of their project, fenced round the Monos' home and nothing else", () => {
    ensureProjectLeads(PROJECTS);
    const lookups = {
      monoOf: (id: string) => (id === "chat-hivra" ? { id: "hivra-lead" } : undefined),
      habitRunMono: () => undefined,
      isLead: (id: string) => !!leadFor(id),
    };
    expect(hubChatIdentity("chat-hivra", lookups)).toMatchObject({ kind: "mono", monoId: "hivra-lead", role: "lead", chat: "chat-hivra" });
    // Nothing but the fence round the Monos' home, which every hub chat has, and no Claude Code worktrees of its own.
    expect(hubMcpArgs("chat-hivra", { cli: null }, lookups)).toEqual(["--disallowedTools", ["Edit(~/agent-memory/monos/**)", ...OLD_MONO_COPY_DENIED_TOOLS, "mcp__ash-os", ...CREDENTIAL_DENIED_TOOLS, ...HUB_DB_DENY_RULES, ...SECRET_ACTION_DENY_RULES, ...GIT_HOOK_DENY_RULES, ...GUARD_STORE_DENY_RULES, ...HUB_WORKTREE_DENIED_TOOLS].join(",")]);
  });

  it("have a soul that is the first mate contract plus who they are, and nothing about a particular person", () => {
    ensureProjectLeads(PROJECTS);
    const lead = leadFor("vg-game-lead");
    expect(lead).toBeDefined();
    const soul = leadSoul(lead!, "/Users/ash/Projects/boxin game?/vg-game");
    expect(soul.startsWith("# Soul\n\n## Role\n")).toBe(true);
    expect(soul).toContain("You are EXO lead, the lead for EXO (project `vg-game`), working in /Users/ash/Projects/boxin game?/vg-game.");
    expect(soul).toContain(FIRST_MATE_CONTRACT);
    expect(soul).not.toMatch(/\bAsh\b|Grok Bot|Chief of Staff|DeepSeek/);
    expect(soul).not.toMatch(/\bash_[a-z_]+|Ash OS project/);
    expect(leadSoul(leadFor("hub-lead")!, null)).toBe(
      `# Soul\n\n## Role\nYou are Hub lead, the lead for MonoCode Hub (project \`hub\`).\n\n## Who I am\nYou lead this project's coding team. You take a goal, brief the work, and report what actually happened.\n\n${FIRST_MATE_CONTRACT}\n`,
    );
  });

  it("get their SOUL.md and MEMORY.md written into the app-data folder (monos/<id>/)", async () => {
    ensureProjectLeads(PROJECTS);
    const leads = listMonos();
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads) await loadMonoFiles(lead.id);
    for (const lead of leads) {
      const dir = path.join(appData, "monos", lead.id);
      const soul = fs.readFileSync(path.join(dir, "SOUL.md"), "utf8");
      expect(soul.startsWith("# Soul\n\n## Role\n")).toBe(true);
      expect(soul).toContain(`You are ${lead.name}`);
      expect(soul).toContain("You are a first mate.");
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

describe("no project has a private lead", () => {
  const HARNESS_LEAD = { id: "ash-lead", name: "Harness lead", mascot: "robot", color: "x", projects: ["/Users/ash/Projects/exo-cc-studio"], sessionId: "s-harness-chat" };

  it("the global `ash` memory never gets a Lead, whatever is sent", () => {
    const result = ensureProjectLeads([GLOBAL_ASH]);
    expect(result).toEqual({ created: [], tied: [], adopted: [] });
    expect(listMonos()).toEqual([]);
    ensureProjectLeads([...PROJECTS, GLOBAL_ASH]);
    expect(listMonos().map((m) => m.id)).toEqual(["vg-game-lead", "hivra-lead", "nibbii-lead", "hub-lead"]);
  });

  it("an existing ash-lead stays the hub lead, and hub-lead is not created beside it", () => {
    addMono(HARNESS_LEAD);
    const register = vi.fn(async () => undefined);
    const unregister = vi.fn(async () => undefined);
    const result = ensureProjectLeads(PROJECTS, register, unregister);
    expect(result.created).not.toContain("hub-lead");
    expect(result.adopted).toEqual(["ash-lead"]);
    expect(listMonos().some((m) => m.id === "hub-lead")).toBe(false);
    expect(listMonos().find((m) => m.id === "ash-lead")).toMatchObject({
      name: "Hub lead",
      sessionId: "s-harness-chat",
      projects: ["/Users/ash/Projects/monocode-hub", "/Users/ash/Projects/exo-cc-studio"],
    });
    expect(leadFor("ash-lead")?.projectId).toBe("hub");
    expect(leadWorkingFolder("ash-lead")).toBe("/Users/ash/Projects/monocode-hub");
    expect(register).toHaveBeenCalledWith("ash-lead", "hub");
    expect(unregister).toHaveBeenCalledWith("ash-lead", "ash");
    // A second pass does not make hub-lead either. The adoption is recorded once the soul reseed finishes.
    expect(ensureProjectLeads(PROJECTS, register, unregister).created).not.toContain("hub-lead");
    expect(listMonos().some((m) => m.id === "hub-lead")).toBe(false);
  });

  it("records a reseed only once it is written, and a failing one is tried again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: number[] = [];
    const never = vi.fn(async () => {
      throw new Error("SOUL.md changed under us");
    });
    expect(await completeLeadAdoption("ash-lead", never, { wait: async (ms) => void waits.push(ms) })).toBe(false);
    expect(never).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([5_000, 30_000, 120_000]);
    expect(localStorage.getItem("monocode:hub-lead-adopted")).toBeNull();
    let tries = 0;
    const flaky = async () => {
      if (tries++ === 0) throw new Error("busy");
    };
    expect(await completeLeadAdoption("ash-lead", flaky, { wait: async () => {} })).toBe(true);
    error.mockRestore();
    expect(JSON.parse(localStorage.getItem("monocode:hub-lead-adopted")!)).toEqual(["ash-lead"]);
  });

  it("does not reseed a mono that is not a legacy seat, so a soul a person wrote stays", async () => {
    const own = "# Soul\n\nA person's own words.\n";
    const files = new Map<string, string>([["ash-lead/SOUL.md", own]]);
    const read = async (id: string, p: string) => ({ text: files.get(`${id}/${p}`) ?? null, hash: files.get(`${id}/${p}`) ?? "" });
    const write = async (id: string, p: string, text: string) => void files.set(`${id}/${p}`, text);
    addMono(HARNESS_LEAD);
    ensureProjectLeads(PROJECTS);
    expect(await reseedAdoptedLeadSoul("ash-lead", "/x", defaultSoul, read, write)).toBe(false);
    expect(await reseedAdoptedLeadSoul("hivra-lead", "/x", defaultSoul, read, write)).toBe(false);
    expect(files.get("ash-lead/SOUL.md")).toBe(own);
    expect(files.has("ash-lead/memory/harness-lead-soul.md")).toBe(false);
  });

  it("every lead's soul is the same contract, and no project gets extra rules", () => {
    ensureProjectLeads(PROJECTS);
    const hub = leadSoul(leadFor("hub-lead")!, "/r");
    const hivra = leadSoul(leadFor("hivra-lead")!, "/r");
    expect(hub).toContain(FIRST_MATE_CONTRACT);
    expect(hivra).toContain(FIRST_MATE_CONTRACT);
    expect(hub).toContain("You are Hub lead, the lead for MonoCode Hub (project `hub`), working in /r.");
    expect(hivra).toContain("You are Hivra lead, the lead for Hivra (project `hivra`), working in /r.");
    expect(hub).not.toContain("Developing the hub from inside the hub");
    expect(hivra).not.toContain("Hold the line on RED");
  });
});

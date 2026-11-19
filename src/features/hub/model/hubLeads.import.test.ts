// @vitest-environment happy-dom
// After the one-time import from Ash OS's record, the Hub's Lead pass finds the Leads Ash already has (each is
// `<project id>-lead`, as every Lead in his record is): no second Lead is made, and the memberships stay what Ash OS
// recorded. Invented data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { addMono, listMonos } from "../../monos/model/mono";
import { ensureProjectLeads, leadFor } from "./hubLeads";
import { LocalHub, memoryDisk } from "./localHub/localHub";
import { runAshOsImport, type ImportFound } from "./localHub/ashOsImport";
import { stripProjects } from "./hubProjects";
import type { HubProject } from "./types";

const PROJECTS = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/tmp/fixture/vg-game", workOwner: "ash_os", status: "active" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/tmp/fixture/hivra", workOwner: "ash_os", status: "active" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/tmp/fixture/nibbii", workOwner: "ash_os", status: "active" },
  { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge", folder: "/tmp/fixture/hub", workOwner: "ash_os", status: "active" },
  { id: "kids-sums", name: "Sums", shortName: "Sums", iconShape: "book", folder: "/tmp/fixture/kids-sums", workOwner: "ash_os", status: "active", archived: true },
];
const TEAM = ["cos", "pm", "frank"];
const membership = (monoId: string, projectId: string, role: "lead" | "member") => ({ monoId, projectId, role, addedAt: "2026-10-15T02:32:48.622547Z" });

/** What Ash OS's record holds: each project's Lead, plus the team in every project. */
function found(): ImportFound {
  return {
    state: "found",
    projects: PROJECTS,
    memberships: PROJECTS.flatMap((p) => [membership(`${p.id}-lead`, p.id, "lead"), ...TEAM.map((m) => membership(m, p.id, "member"))]),
    pages: [],
  };
}

const key = (m: { monoId: string; projectId: string; role: string }) => `${m.projectId}:${m.monoId}:${m.role}`;

beforeEach(() => {
  localStorage.clear();
});

describe("Leads after the import", () => {
  it("are the Monos Ash already has: no second Lead, and the memberships match", async () => {
    // Some of the record's Leads are on this Mac's roster already; the others are made, under the same ids.
    for (const id of ["hivra-lead", "hub-lead", ...TEAM])
      addMono({ id, name: id, mascot: "cat", color: "red", projects: [], engine: "claude", instructions: "" });
    const hub = new LocalHub(memoryDisk());
    const decision = await runAshOsImport(hub, { fetch: async () => found(), ask: async () => "import" });
    expect(decision).toMatchObject({ decided: "imported", added: { projects: 5, memberships: 20, pages: 0 } });
    const imported = (await hub.monoProjects()).memberships.map(key).sort();

    // What the Hub's Lead pass sees: the strip (the archived one is not on it).
    const strip = stripProjects((await hub.projects()).projects as unknown as HubProject[]);
    expect(strip.map((p) => p.id)).toEqual(["vg-game", "hivra", "nibbii", "hub"]);
    const register = (monoId: string, projectId: string) => hub.monoProjectAdd({ mono_id: monoId, project_id: projectId, role: "lead" });
    const result = ensureProjectLeads(strip, register);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.created.sort()).toEqual(["nibbii-lead", "vg-game-lead"]);
    expect(leadFor("hivra-lead")?.projectId).toBe("hivra");
    // Registering the Leads adds nothing: the record already says who leads what.
    expect((await hub.monoProjects()).memberships.map(key).sort()).toEqual(imported);
    // Each Lead is tied to its project's folder.
    expect(listMonos().find((m) => m.id === "hivra-lead")?.projects).toEqual(["/tmp/fixture/hivra"]);
    expect(listMonos().find((m) => m.id === "vg-game-lead")?.projects).toEqual(["/tmp/fixture/vg-game"]);

    // A second pass changes nothing.
    const before = listMonos().map((m) => m.id);
    expect(ensureProjectLeads(strip, register).created).toEqual([]);
    expect(listMonos().map((m) => m.id)).toEqual(before);
  });
});

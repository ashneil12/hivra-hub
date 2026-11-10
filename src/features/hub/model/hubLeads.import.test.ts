// @vitest-environment happy-dom
// After the one-time import from Ash OS's record, the Hub's Lead pass adopts the Monos Ash already has as each
// project's Lead: no second Lead is made, and the memberships stay what Ash OS recorded. Invented data only.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { addMono, listMonos } from "../../monos/model/mono";
import { markMonoRemovedByUser } from "./builtInMonos";
import { ensureProjectLeads, leadFor, leadsByProject } from "./hubLeads";
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

/** What Ash OS's record holds: each project's Lead (Nibbii's under an id of its own), plus the team in every project. */
function found(): ImportFound {
  const leads: Record<string, string> = { "vg-game": "vg-game-lead", hivra: "hivra-lead", nibbii: "nibbii-boss", hub: "hub-lead", "kids-sums": "kids-sums-lead" };
  return {
    state: "found",
    projects: PROJECTS,
    memberships: PROJECTS.flatMap((p) => [membership(leads[p.id], p.id, "lead"), ...TEAM.map((m) => membership(m, p.id, "member"))]),
    pages: [],
  };
}

/** Ash's roster as it stands: every project's Lead is already a Mono, and the team. */
function seedRoster() {
  for (const id of ["vg-game-lead", "hivra-lead", "nibbii-boss", "hub-lead", "kids-sums-lead", ...TEAM])
    addMono({ id, name: id, mascot: "cat", color: "red", projects: [], engine: "claude", instructions: "" });
}

const key = (m: { monoId: string; projectId: string; role: string }) => `${m.projectId}:${m.monoId}:${m.role}`;

beforeEach(() => {
  localStorage.clear();
});

describe("Leads after the import", () => {
  it("adopt the Monos Ash already has: no second Lead, and the memberships match", async () => {
    seedRoster();
    const before = listMonos().map((m) => m.id);
    const hub = new LocalHub(memoryDisk());
    const decision = await runAshOsImport(hub, { fetch: async () => found(), ask: async () => "import" });
    expect(decision).toMatchObject({ decided: "imported", added: { projects: 5, memberships: 20, pages: 0 } });
    const imported = (await hub.monoProjects()).memberships.map(key).sort();

    // What the Hub's Lead pass sees: the strip (the archived one is not on it) and the memberships.
    const strip = stripProjects((await hub.projects()).projects as unknown as HubProject[]);
    expect(strip.map((p) => p.id)).toEqual(["vg-game", "hivra", "nibbii", "hub"]);
    const register = (monoId: string, projectId: string) => hub.monoProjectAdd({ mono_id: monoId, project_id: projectId, role: "lead" });
    const result = ensureProjectLeads(strip, register, undefined, { leadOf: leadsByProject((await hub.monoProjects()).memberships) });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.created).toEqual([]);
    expect(listMonos().map((m) => m.id)).toEqual(before);
    // Nibbii's Lead is the Mono Ash OS named, not a new nibbii-lead.
    expect(listMonos().some((m) => m.id === "nibbii-lead")).toBe(false);
    expect(leadFor("nibbii-boss")?.projectId).toBe("nibbii");
    expect((await hub.monoProjects()).memberships.map(key).sort()).toEqual(imported);
    // Each Lead is tied to its project's folder.
    expect(listMonos().find((m) => m.id === "hivra-lead")?.projects).toEqual(["/tmp/fixture/hivra"]);
    expect(listMonos().find((m) => m.id === "nibbii-boss")?.projects).toEqual(["/tmp/fixture/nibbii"]);

    // A second pass changes nothing.
    expect(ensureProjectLeads(strip, register, undefined, { leadOf: leadsByProject((await hub.monoProjects()).memberships) }).created).toEqual([]);
    expect(listMonos().map((m) => m.id)).toEqual(before);
  });

  it("never adopts over a Lead Ash removed, a team Mono, a Mono recorded for two projects, or the checker", () => {
    for (const id of ["cos", "twice", "checker", "solo-boss"])
      addMono({ id, name: id, mascot: "cat", color: "red", projects: [], engine: "claude", instructions: "" });
    const strip: HubProject[] = ["hivra", "one", "two", "check", "team"].map((id) => ({
      id,
      name: id,
      shortName: id,
      iconShape: "folder",
      folder: `/tmp/fixture/${id}`,
    }));
    markMonoRemovedByUser("hivra-lead");
    const leadOf = leadsByProject([
      // Ash removed hivra-lead: the record's Lead for Hivra doesn't come in its place.
      membership("solo-boss", "hivra", "lead"),
      // Lead of two projects: neither.
      membership("twice", "one", "lead"),
      membership("twice", "two", "lead"),
      membership("checker", "check", "lead"),
      // A team Mono that works across projects.
      membership("cos", "team", "lead"),
      membership("cos", "hivra", "member"),
    ]);
    const result = ensureProjectLeads(strip, undefined, undefined, { leadOf });
    expect(result.created).toEqual(["one-lead", "two-lead", "check-lead", "team-lead"]);
    for (const id of ["solo-boss", "twice", "checker", "cos"]) expect(leadFor(id)).toBeUndefined();
    expect(listMonos().some((m) => m.id === "hivra-lead")).toBe(false);
    expect(listMonos().find((m) => m.id === "solo-boss")?.projects).toEqual([]);
  });

  it("adopts a recorded Mono for one project only", () => {
    addMono({ id: "solo-boss", name: "solo-boss", mascot: "cat", color: "red", projects: [], engine: "claude", instructions: "" });
    const strip: HubProject[] = ["a", "b"].map((id) => ({ id, name: id, shortName: id, iconShape: "folder", folder: `/tmp/fixture/${id}` }));
    // The store names it for both, but only as a's Lead does it belong to one project alone.
    const leadOf = (projectId: string) => (projectId === "a" || projectId === "b" ? "solo-boss" : undefined);
    const result = ensureProjectLeads(strip, undefined, undefined, { leadOf });
    expect(result.created).toEqual(["b-lead"]);
    expect(leadFor("solo-boss")?.projectId).toBe("a");
  });

  it("still makes a Lead for a project nobody leads", () => {
    const strip: HubProject[] = [{ id: "fresh", name: "Fresh", shortName: "Fresh", iconShape: "folder", folder: "/tmp/fixture/fresh" }];
    // A recorded Lead that isn't on the roster is not adopted either.
    expect(ensureProjectLeads(strip, undefined, undefined, { leadOf: leadsByProject([membership("gone", "fresh", "lead")]) }).created).toEqual(["fresh-lead"]);
  });
});

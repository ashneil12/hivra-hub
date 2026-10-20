// @vitest-environment happy-dom
// The seam for double delegation (leadership team -> project Lead -> subagents). The delegate tool itself is H3; this
// proves who a team Mono may brief (through its project membership), the brief's shape, and that delegating is refused
// plainly until H3 registers its implementation.
import { beforeEach, describe, expect, it } from "vitest";
import { ensureBuiltInMonos } from "./builtInMonos";
import { ensureProjectLeads } from "./hubLeads";
import { tieTeamToProjects } from "./hubTeam";
import { briefsLeads, delegateToLead, formatLeadBrief, leadDelegationReady, leadTargetsFor, setLeadDelegator } from "./leadershipDelegation";
import type { HubProject } from "./types";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/p/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/p/hivra" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/p/nibbii" },
  { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge", folder: "/p/monocode-hub" },
];

beforeEach(() => localStorage.clear());

describe("leadership -> Lead", () => {
  it("through membership, Chief of Staff's reachable Leads are the four project Leads (the double-delegation seam)", async () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    expect(leadTargetsFor("chief-of-staff", PROJECTS)).toEqual([]); // not a member of anything yet
    tieTeamToProjects(PROJECTS);
    expect(leadTargetsFor("chief-of-staff", PROJECTS).map((t) => [t.leadName, t.projectId])).toEqual([
      ["EXO lead", "vg-game"], ["Hivra lead", "hivra"], ["Nibbii lead", "nibbii"], ["MonoCode Hub lead", "hub"],
    ]);
    expect(leadTargetsFor("hivra-lead", PROJECTS)).toEqual([]); // a Lead briefs workers, not other Leads
    const brief = formatLeadBrief("Chief of Staff", { outcome: "Ship the room", done: "Ash clicks it in the app" });
    expect(brief.split("\n")[0]).toBe("[MonoCode brief from Chief of Staff]");
    expect(brief).toContain("start-ack");
    // H3 plugs in here; until then delegating says so plainly
    expect(leadDelegationReady()).toBe(false);
    const target = leadTargetsFor("chief-of-staff", PROJECTS)[1];
    await expect(delegateToLead("chief-of-staff", target, { outcome: "x", done: "y" }, PROJECTS)).rejects.toThrow("isn't connected yet");
    const undo = setLeadDelegator(async () => ({ taskId: "t1" }));
    await expect(delegateToLead("chief-of-staff", target, { outcome: "x", done: "y" }, PROJECTS)).resolves.toEqual({ taskId: "t1" });
    await expect(delegateToLead("someone", target, { outcome: "x", done: "y" }, PROJECTS)).rejects.toThrow("isn't in one of your projects");
    undo();
  });


  it("only the leadership team briefs Leads", () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    expect(briefsLeads("chief-of-staff")).toBe(true);
    expect(briefsLeads("hivra-lead")).toBe(false);
    expect(briefsLeads("nobody")).toBe(false);
  });
});

// @vitest-environment happy-dom
// The seam for double delegation (leadership team -> project Lead -> subagents). The delegate tool itself is H3; this
// proves who a team Mono may brief (through its project membership), the brief's shape, and that delegating is refused
// plainly until H3 registers its implementation.
import { beforeEach, describe, expect, it } from "vitest";
import { ensureBuiltInMonos } from "./builtInMonos";
import { ensureProjectLeads } from "./hubLeads";
import { tieTeamToProjects } from "./hubTeam";
import { addMono, createMono, listMonos, removeMonoProject } from "../../monos/model/mono";
import {
  briefsLeads,
  delegateToLead,
  findLeadTarget,
  formatLeadBrief,
  leadBriefPrompt,
  leadDelegationReady,
  leadTargetsFor,
  setLeadDelegator,
} from "./leadershipDelegation";
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
    await expect(delegateToLead("someone", target, { outcome: "x", done: "y" }, PROJECTS)).rejects.toThrow("isn't here");
    await expect(delegateToLead("hivra-lead", target, { outcome: "x", done: "y" }, PROJECTS)).rejects.toThrow("doesn't brief another Lead");
    await expect(delegateToLead("chief-of-staff", { ...target, projectId: "elsewhere" }, "x", PROJECTS)).rejects.toThrow("isn't in one of your projects");
    undo();
  });

  it("a Lead that isn't a member of its project can't be briefed there; a Lead is found by its id, name or project", () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    tieTeamToProjects(PROJECTS);
    expect(findLeadTarget("chief-of-staff", PROJECTS, "hub")?.leadName).toBe("MonoCode Hub lead");
    expect(findLeadTarget("chief-of-staff", PROJECTS, "MonoCode Hub")?.projectId).toBe("hub");
    expect(findLeadTarget("chief-of-staff", PROJECTS, "monocode hub lead")?.projectId).toBe("hub");
    expect(findLeadTarget("chief-of-staff", PROJECTS, "Nobody")).toBeUndefined();
    // Take the Hub lead off its project: it stops being a target.
    const lead = listMonos().find((m) => m.name === "MonoCode Hub lead")!;
    removeMonoProject(lead.id, "/p/monocode-hub");
    expect(findLeadTarget("chief-of-staff", PROJECTS, "hub")).toBeUndefined();
    expect(leadTargetsFor("chief-of-staff", PROJECTS).map((t) => t.projectId)).toEqual(["vg-game", "hivra", "nibbii"]);
  });

  it("a project beyond the four (one Ash made with New project) has a Lead the team can brief too", () => {
    const more: HubProject[] = [...PROJECTS, { id: "verify", name: "Verify", shortName: "Verify", iconShape: "rocket", folder: "/p/verify" }];
    ensureBuiltInMonos();
    ensureProjectLeads(more);
    tieTeamToProjects(more);
    const target = findLeadTarget("chief-of-staff", more, "verify");
    expect(target).toMatchObject({ leadId: "verify-lead", leadName: "Verify lead", projectId: "verify", folder: "/p/verify" });
    expect(leadTargetsFor("chief-of-staff", more).map((t) => t.projectId)).toEqual(["vg-game", "hivra", "nibbii", "hub", "verify"]);
    // Still only through membership, and never the global memory.
    expect(leadTargetsFor("chief-of-staff", [...more, { id: "ash", name: "Ash", shortName: "Ash", iconShape: "folder", folder: "/p/ash" }]).map((t) => t.projectId)).not.toContain("ash");
    removeMonoProject("chief-of-staff", "/p/verify");
    expect(findLeadTarget("chief-of-staff", more, "verify")).toBeUndefined();
  });

  it("a delegate-tool brief to a Lead says how a Lead works it, with no Done when (no /goal in a Lead's chat)", () => {
    const text = leadBriefPrompt("Chief of Staff", "Ash said: \"ship the room\".", "the room shows the report");
    expect(text.split("\n")[0]).toBe("[MonoCode brief from Chief of Staff]");
    expect(text).toContain("Done looks like: the room shows the report");
    expect(text).not.toContain("Done when:");
    expect(text).toContain("delegate_task");
  });


  it("every Mono briefs Leads (Ash, 20 Oct), not only the leadership team; a Lead and the checker never do", async () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    expect(briefsLeads("chief-of-staff")).toBe(true);
    expect(briefsLeads("hivra-lead")).toBe(false);
    expect(briefsLeads("nobody")).toBe(false);
    // A Mono Ash made himself (a marketing Mono), once it is a member of EXO, briefs EXO's coding team like the team does.
    const marketing = createMono(["/p/vg-game"]);
    expect(briefsLeads(marketing.id)).toBe(true);
    expect(leadTargetsFor(marketing.id, PROJECTS).map((t) => t.projectId)).toEqual(["vg-game"]);
    const undo = setLeadDelegator(async () => ({ taskId: "t9" }));
    await expect(delegateToLead(marketing.id, leadTargetsFor(marketing.id, PROJECTS)[0], "fix it", PROJECTS)).resolves.toEqual({ taskId: "t9" });
    undo();
    // The checker only reads.
    addMono({ id: "checker", name: "Checker", mascot: "ghost", color: "#888", projects: ["/p/vg-game"] });
    expect(briefsLeads("checker")).toBe(false);
  });
});

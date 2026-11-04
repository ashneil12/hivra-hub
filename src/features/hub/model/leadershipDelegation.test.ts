// @vitest-environment happy-dom
// Who may brief a project's Lead: every ordinary Mono that is a member of that project. A Lead and the checker never
// brief. Membership is the gate, and a project beyond the old four still has a Lead.
import { beforeEach, describe, expect, it } from "vitest";
import { addMono, addMonoProject, createMono, removeMonoProject } from "../../monos/model/mono";
import { ensureProjectLeads } from "./hubLeads";
import {
  briefsLeads,
  delegateToLead,
  findLeadTarget,
  formatLeadBrief,
  leadBriefPrompt,
  leadDelegationReady,
  leadNoteName,
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

const MINA = { id: "mina", name: "Mina", mascot: "letter", color: "x", projects: PROJECTS.map((p) => p.folder!) };

beforeEach(() => localStorage.clear());

describe("any Mono -> Lead", () => {
  it("an ordinary Mono can brief the Lead of each project it belongs to, and a Lead never briefs", async () => {
    ensureProjectLeads(PROJECTS);
    expect(leadTargetsFor("mina", PROJECTS)).toEqual([]);
    addMono(MINA);
    expect(leadTargetsFor("mina", PROJECTS).map((t) => [t.leadName, t.projectId])).toEqual([
      ["EXO lead", "vg-game"],
      ["Hivra lead", "hivra"],
      ["Nibbii lead", "nibbii"],
      ["Hub lead", "hub"],
    ]);
    expect(leadTargetsFor("hivra-lead", PROJECTS)).toEqual([]);
    const brief = formatLeadBrief("Mina", { outcome: "Ship the room", done: "it is clicked in the app" });
    expect(brief.split("\n")[0]).toBe("[MonoCode brief from Mina]");
    expect(brief).toContain("start-ack");
    expect(leadDelegationReady()).toBe(false);
    const target = leadTargetsFor("mina", PROJECTS)[1];
    await expect(delegateToLead("mina", target, { outcome: "x", done: "y" }, PROJECTS)).rejects.toThrow("isn't connected yet");
    const undo = setLeadDelegator(async () => ({ taskId: "t1" }));
    await expect(delegateToLead("mina", target, { outcome: "x", done: "y" }, PROJECTS)).resolves.toEqual({ taskId: "t1" });
    await expect(delegateToLead("someone", target, { outcome: "x", done: "y" }, PROJECTS)).rejects.toThrow("isn't here");
    await expect(delegateToLead("hivra-lead", target, { outcome: "x", done: "y" }, PROJECTS)).rejects.toThrow("doesn't brief another Lead");
    await expect(delegateToLead("mina", { ...target, projectId: "elsewhere" }, "x", PROJECTS)).rejects.toThrow("isn't in one of your projects");
    undo();
  });

  it("a Lead that isn't a member of its project can't be briefed there; a Lead is found by its id, name or project", () => {
    ensureProjectLeads(PROJECTS);
    addMono(MINA);
    expect(findLeadTarget("mina", PROJECTS, "hub")?.leadName).toBe("Hub lead");
    expect(findLeadTarget("mina", PROJECTS, "Hub lead")?.projectId).toBe("hub");
    expect(findLeadTarget("mina", PROJECTS, "MonoCode Hub")?.projectId).toBe("hub");
    expect(findLeadTarget("mina", PROJECTS, "monocode hub lead")?.projectId).toBe("hub");
    expect(findLeadTarget("mina", PROJECTS, "Nobody")).toBeUndefined();
    removeMonoProject("hub-lead", "/p/monocode-hub");
    expect(findLeadTarget("mina", PROJECTS, "hub")).toBeUndefined();
    expect(leadTargetsFor("mina", PROJECTS).map((t) => t.projectId)).toEqual(["vg-game", "hivra", "nibbii"]);
  });

  it("a project beyond those four still has a Lead, and the global memory never does", () => {
    const verify: HubProject = { id: "verify", name: "Verify", shortName: "Verify", iconShape: "rocket", folder: "/p/verify" };
    const more = [...PROJECTS, verify];
    ensureProjectLeads(more);
    addMono({ ...MINA, projects: [...MINA.projects, "/p/verify", "/p/ash"] });
    const target = findLeadTarget("mina", more, "verify");
    expect(target).toMatchObject({ leadId: "verify-lead", leadName: "Verify lead", projectId: "verify", folder: "/p/verify" });
    expect(leadTargetsFor("mina", more).map((t) => t.projectId)).toEqual(["vg-game", "hivra", "nibbii", "hub", "verify"]);
    const withAsh: HubProject[] = [...more, { id: "ash", name: "Harness", shortName: "Harness", iconShape: "folder", folder: "/p/ash" }];
    expect(leadTargetsFor("mina", withAsh).map((t) => t.projectId)).not.toContain("ash");
    removeMonoProject("mina", "/p/verify");
    expect(findLeadTarget("mina", more, "verify")).toBeUndefined();
  });

  it("a delegate-tool brief to a Lead says how a Lead works it, with no Done when (no /goal in a Lead's chat)", () => {
    const text = leadBriefPrompt("Mina", "Ship the room.", "the room shows the report");
    expect(text.split("\n")[0]).toBe("[MonoCode brief from Mina]");
    expect(text).toContain("Done looks like: the room shows the report");
    expect(text).not.toContain("Done when:");
    expect(text).toContain("delegate_task");
  });

  it("every ordinary Mono can brief, including one just made; a Lead and the checker never do", async () => {
    ensureProjectLeads(PROJECTS);
    addMono(MINA);
    expect(briefsLeads("mina")).toBe(true);
    expect(briefsLeads("hivra-lead")).toBe(false);
    expect(briefsLeads("nobody")).toBe(false);
    const marketing = createMono(["/p/vg-game"]);
    expect(briefsLeads(marketing.id)).toBe(true);
    expect(leadTargetsFor(marketing.id, PROJECTS).map((t) => t.projectId)).toEqual(["vg-game"]);
    const undo = setLeadDelegator(async () => ({ taskId: "t9" }));
    await expect(delegateToLead(marketing.id, leadTargetsFor(marketing.id, PROJECTS)[0], "fix it", PROJECTS)).resolves.toEqual({ taskId: "t9" });
    addMono({ id: "checker", name: "Checker", mascot: "ghost", color: "#888", projects: ["/p/vg-game"] });
    expect(briefsLeads("checker")).toBe(false);
    await expect(delegateToLead("checker", leadTargetsFor(marketing.id, PROJECTS)[0], "fix it", PROJECTS)).rejects.toThrow("only reads");
    undo();
  });
});

describe("leadNoteName", () => {
  it("adds the Lead's own name when it differs from the project id", () => {
    expect(leadNoteName({ projectId: "vg-game", leadName: "EXO lead" })).toBe('"vg-game" (EXO lead)');
    expect(leadNoteName({ projectId: "tally", leadName: "Tally lead" })).toBe('"tally"');
    expect(leadNoteName({ projectId: "hub", leadName: "" })).toBe('"hub"');
  });
});

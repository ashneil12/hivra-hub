import { describe, expect, it } from "vitest";
import type { HubJob, HubJobGroup, HubMono, HubProject, Need } from "../../hub/model/types";
import type { WaitingChat } from "../../hub/model/waitingChats";
import {
  pageCapabilityHandlers,
  pageTasks,
  type PageCapabilityData,
} from "./pageCapabilities";

const project = (id: string, name: string, extra: Partial<HubProject> = {}): HubProject => ({
  id,
  name,
  shortName: name.slice(0, 4),
  iconShape: "folder",
  folder: `~/Projects/${id}`,
  ...extra,
});

const need = (id: string, projectId: string, extra: Partial<Need> = {}): Need => ({
  id,
  projectId,
  title: `Task ${id}`,
  why: "Because",
  actionType: "open",
  actionLabel: "See options",
  since: "2026-10-10T09:00:00.000Z",
  ...extra,
});

const job = (id: string, projectId: string, state: HubJob["state"], extra: Partial<HubJob> = {}): HubJob => ({
  id,
  projectId,
  title: `Job ${id}`,
  lead: null,
  leadName: "ed",
  state,
  reason: "",
  startedAt: "2026-10-20T10:00:00.000Z",
  lastActiveAt: "2026-10-20T11:00:00.000Z",
  finishedAt: null,
  seen: false,
  ...extra,
});

const mono = (id: string, name: string, projectIds: string[]): HubMono => ({
  id,
  name,
  mascot: "cat",
  color: "grey",
  status: "idle",
  projectIds,
});

const chat = (sessionId: string, projectId: string, askedAt: number): WaitingChat => ({
  sessionId,
  cwd: "/work/hivra",
  title: "Hivra lead",
  askedAt,
  source: "marker",
  question: "Which plan should Hivra launch on?",
  more: 0,
  redLine: false,
  projectId,
  projectName: projectId === "hivra" ? "Hivra" : "EXO",
  chatName: "Hivra lead",
});

const projects = [
  project("exo", "EXO"),
  project("hivra", "Hivra", { parked: true, folder: null }),
];

const jobs: Record<string, HubJobGroup[]> = {
  exo: [
    { leadId: "ed", leadName: "ed", projectId: "exo", jobs: [job("j1", "exo", "working")] },
    {
      leadId: null,
      leadName: "EXO lead",
      projectId: "exo",
      jobs: [job("j2", "exo", "done"), job("j3", "exo", "sent_to_lead", { reason: "Its Lead is on it" })],
    },
  ],
  hivra: [],
};

const needs: Record<string, Need[]> = {
  exo: [
    need("n1", "exo", { since: "2026-10-12T09:00:00.000Z" }),
    need("n2", "exo", { later: true }),
    need("n3", "exo", { state: "done" }),
  ],
  hivra: [need("n4", "hivra", { why: "Waiting on the pricing page", since: "2026-10-21T09:00:00.000Z" })],
};

const data: PageCapabilityData = {
  projects: () => projects,
  needs: (projectId) => (projectId ? (needs[projectId] ?? []) : []),
  jobs: (projectId) => jobs[projectId] ?? [],
  waiting: () => [chat("s1", "hivra", Date.UTC(2026, 9, 22, 12))],
  monos: (projectId) => [mono("ed", "ed", [projectId]), mono("cam", "Alfred", ["exo", "hivra"])].filter((m) => m.projectIds.includes(projectId)),
  userName: () => "Ash",
  appearance: () => "dark",
  scheme: () => "glass",
};

describe("pageTasks", () => {
  it("lists what waits on Ash, what he parked, what is being built and what is stuck, stuck first", () => {
    const tasks = pageTasks(data, undefined);
    expect(tasks.map((t) => t.id)).toEqual([
      "j3", // stuck: a job its Lead was handed
      "chat:s1", // waiting: the chat asking Ash, newest
      "n4", // waiting: Hivra's need
      "n1", // waiting: EXO's need, older
      "j1", // building
      "n2", // later
    ]);
    expect(tasks.map((t) => t.state)).toEqual(["stuck", "waiting", "waiting", "waiting", "building", "later"]);
  });

  it("skips needs that are done and jobs that have finished", () => {
    const ids = pageTasks(data, "exo").map((t) => t.id);
    expect(ids).not.toContain("n3");
    expect(ids).not.toContain("j2");
  });

  it("turns a waiting chat into an Answerable task and a stuck job into a stuck one with its reason", () => {
    const tasks = pageTasks(data, "hivra");
    const asked = tasks.find((t) => t.id === "chat:s1");
    expect(asked).toMatchObject({ title: "Which plan should Hivra launch on?", state: "waiting", action: "Answer" });
    const stuck = pageTasks(data, "exo").find((t) => t.id === "j3");
    expect(stuck).toMatchObject({ state: "stuck", why: "Its Lead is on it" });
  });

  it("names the project and keeps a project with no folder out of nothing: counts follow the rows", () => {
    const tasks = pageTasks(data, "hivra");
    expect(tasks.every((t) => t.projectName === "Hivra")).toBe(true);
  });
});

describe("pageCapabilityHandlers", () => {
  const handlers = pageCapabilityHandlers(data);

  it("tasks.read narrows to one project by id or by name, and to every project without one", async () => {
    const all = (await handlers["tasks.read"]!({})) as { tasks: unknown[] };
    const exo = (await handlers["tasks.read"]!({ projectId: "exo" })) as { tasks: { projectId: string }[] };
    const named = (await handlers["tasks.read"]!({ projectId: "hIvRa" })) as { tasks: { projectId: string }[] };
    expect(all.tasks.length).toBe(6);
    expect(exo.tasks.every((t) => t.projectId === "exo")).toBe(true);
    expect(named.tasks.every((t) => t.projectId === "hivra")).toBe(true);
  });

  it("tasks.read turns down a project that doesn't exist, in plain words", async () => {
    await expect(handlers["tasks.read"]!({ projectId: "nope" })).rejects.toThrow("There's no project called “nope”.");
  });

  it("project.read shapes one project with its counts, folder and agents", async () => {
    const { project: exo } = (await handlers["project.read"]!({ projectId: "exo" })) as {
      project: Record<string, unknown>;
    };
    expect(exo).toMatchObject({
      id: "exo",
      name: "EXO",
      folder: "~/Projects/exo",
      parked: false,
      counts: { waiting: 1, later: 1, building: 1, stuck: 1 },
      monos: ["ed", "Alfred"],
    });
  });

  it("project.read without an id returns every project, and turns down an unknown one", async () => {
    const { projects: all } = (await handlers["project.read"]!({})) as { projects: { id: string; parked: boolean }[] };
    expect(all.map((p) => p.id)).toEqual(["exo", "hivra"]);
    expect(all.find((p) => p.id === "hivra")?.parked).toBe(true);
    await expect(handlers["project.read"]!({ projectId: "nope" })).rejects.toThrow("There's no project called “nope”.");
  });

  it("settings.read gives the name, light or dark and the scheme, and nothing else", async () => {
    const settings = (await handlers["settings.read"]!({})) as Record<string, unknown>;
    expect(settings).toEqual({ name: "Ash", appearance: "dark", scheme: "glass" });
  });
});

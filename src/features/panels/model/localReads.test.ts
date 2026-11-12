import { expect, it } from "vitest";
import type { Decision } from "../../firstmate/model/steering";
import type { HubProject } from "../../hub/model/types";
import type { Delegation } from "../../monos/model/delegations";
import type { Mono } from "../../monos/model/mono";
import { localHandlers, localJobGroups, localSources } from "./localReads";

const project: HubProject = { id: "shop", name: "Example shop", shortName: "Shop", iconShape: "sparkles", folder: null };

function row(over: Partial<Delegation>): Delegation {
  return {
    id: "d1",
    ownerSession: "lead-chat",
    ownerMono: "lead",
    batchId: null,
    parentId: null,
    rootId: "d1",
    childSession: "child",
    requestId: "r1",
    generation: 1,
    project: "shop",
    title: "Example: paint the sign",
    brief: null,
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...over,
  };
}

const decision: Decision = {
  project: "shop",
  decisionKey: "price",
  question: "Example: what is the price?",
  options: ["Low", "High"],
  recommended: "Low",
  askedBy: "lead",
  askedByMono: "lead",
  waiting: [],
  state: "open",
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  version: 1,
};

it("reads tasks, the project, jobs and agents from local delegations and projects", async () => {
  const records = {
    projects: [project],
    delegations: [row({}), row({ id: "done", state: "completed", title: "Example: finished" }), row({ id: "blank", title: "  " })],
    decisions: [decision, { ...decision, decisionKey: "old", state: "answered" as const }],
    monos: [{ id: "lead", name: "Lead", mascot: "a", color: "#000", projects: [], sessionId: "lead-chat" } as Mono],
  };
  const handlers = localHandlers(records);
  const tasks = await handlers["tasks.read"]?.({});
  const text = JSON.stringify(tasks);
  expect(text).toContain("Example: paint the sign");
  expect(text).toContain("Example: what is the price?");
  expect(text).not.toContain("Example: finished");
  const projects = await handlers["project.read"]?.({});
  expect(JSON.stringify(projects)).toContain("Example shop");

  const jobs = localSources(records)["jobs.read"].read({});
  expect(JSON.stringify(jobs)).toContain("Example: paint the sign");
  expect(JSON.stringify(jobs)).not.toContain("Example: finished");
  const agents = localSources(records, 1_700_000_200_000)["agents.read"].read({});
  expect(JSON.stringify(agents)).toContain("Example: paint the sign");
  expect(localJobGroups({ projects: [], delegations: [] })).toEqual([]);
});
